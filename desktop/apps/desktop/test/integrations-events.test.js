'use strict'
// Richer playback events (start / pause / resume / progress / stop with user, device, ids, position
// and direct-vs-transcode), the now-playing endpoint's shape, and the live Server-Sent-Events stream.
// Run: node --test test/integrations-events.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const webhooks = require('../electron/webhooks')
const history = require('../electron/history')
const parental = require('../electron/parentalControls')
const eventStream = require('../electron/eventStream')
const { createFixture } = require('./helpers/publicApiFixture')

const fakeStore = (initial = {}) => {
  const data = { ...initial }
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
}

async function receiver() {
  const hits = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { hits.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') }); res.writeHead(200); res.end('ok') })
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${srv.address().port}/hook`, hits, events: () => hits.map((h) => JSON.parse(h.raw)), close: () => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(resolve) }) }
}

test.beforeEach(() => {
  webhooks._reset()
  webhooks.configure({ retryDelaysMs: [5, 5], timeoutMs: 2000, progressEveryMs: 60 * 1000 })
})

const USERS = [
  { id: 'u1', name: 'Sam', username: 'sam', status: 'approved', adult: true },
  { id: 'hidden', name: 'Hidden', username: 'hidden', status: 'approved', adult: true, viewingHistoryPrivate: true },
  { id: 'kid', name: 'Kid', username: 'kid', status: 'approved' }
]
const ALL_PLAYBACK = ['playback.started', 'playback.paused', 'playback.resumed', 'playback.progress', 'playback.stopped', 'playback.watched']

// Date.now under the test's control, so "a minute later" does not take a minute.
function clock(t) {
  const real = Date.now
  let now = real()
  Date.now = () => now
  t.after(() => { Date.now = real })
  return { advance: (ms) => { now += ms }, now: () => now }
}

async function setup(t, events = ALL_PLAYBACK) {
  const store = fakeStore({ watchedState: { schema: 1, migratedAt: 1, users: {} }, authUsers: USERS })
  parental.setPolicy(store, 'kid', parental.presetPolicy('kids'))
  const rx = await receiver()
  t.after(rx.close)
  const made = await webhooks.create(store, { name: 'Recv', url: rx.url, events, allowPrivateNetwork: true })
  assert.equal(made.ok, true)
  return { store, rx }
}

const names = (rx) => rx.events().map((e) => e.event)

test('a session: started, paused, resumed, progress, stopped, each carrying user, media ids, position and how it is served', async (t) => {
  const c = clock(t)
  const { store, rx } = await setup(t)
  webhooks.setPlaybackContext((row) => ({
    device: 'Chrome on Windows',
    location: 'home',
    playback: 'transcode',
    transcode: { reason: 'Converting to 720p', videoCodec: 'hevc', audioCodec: 'eac3', quality: '720p' },
    media: { year: 1995, ids: { tmdb: 949, imdb: 'tt0113277', tvdb: null } }
  }))
  const sid = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: 'C:\\Secret\\Heat (1995).mp4', kind: 'movie' })
  await webhooks.whenIdle()

  // The player says what it is doing.
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 15, duration: 6000, state: 'playing' })
  await webhooks.whenIdle() // deliveries run side by side, so let each land before the next change
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 30, duration: 6000, state: 'paused' })
  await webhooks.whenIdle() // deliveries run side by side, so let each land before the next change
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 30, duration: 6000, state: 'paused' })
  await webhooks.whenIdle() // deliveries run side by side, so let each land before the next change
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 30, duration: 6000, state: 'playing' })
  await webhooks.whenIdle() // deliveries run side by side, so let each land before the next change
  c.advance(61000)
  history.updateSession(store, sid, { currentTime: 90, duration: 6000, state: 'playing' })
  await webhooks.whenIdle() // deliveries run side by side, so let each land before the next change
  c.advance(5000)
  history.updateSession(store, sid, { currentTime: 95, duration: 6000, state: 'stopped' })
  await webhooks.whenIdle() // deliveries run side by side, so let each land before the next change
  await webhooks.whenIdle()

  assert.deepEqual(names(rx), ['playback.started', 'playback.paused', 'playback.resumed', 'playback.progress', 'playback.stopped'], 'one event per change; a repeated pause is not announced again')
  const [started, paused, resumed, progress, stopped] = rx.events().map((e) => e.data)
  assert.deepEqual(started.user, { id: 'u1', name: 'Sam' })
  assert.deepEqual(started.media, { kind: 'movie', title: 'Heat', year: 1995, ids: { tmdb: 949, imdb: 'tt0113277', tvdb: null } })
  assert.equal(started.session.device, 'Chrome on Windows')
  assert.equal(started.session.location, 'home')
  assert.equal(started.session.playback, 'transcode')
  assert.deepEqual(started.session.transcode, { reason: 'Converting to 720p', videoCodec: 'hevc', audioCodec: 'eac3', quality: '720p' })
  assert.equal(started.session.state, 'playing')
  assert.equal(paused.session.state, 'paused')
  assert.equal(paused.positionSeconds, 30)
  assert.equal(paused.durationSeconds, 6000)
  assert.equal(paused.percent, 1)
  assert.equal(resumed.session.state, 'playing')
  assert.equal(progress.positionSeconds, 90)
  assert.equal(progress.percent, 2)
  assert.equal(stopped.session.state, 'stopped')
  assert.equal(stopped.positionSeconds, 95)
  assert.ok(stopped.sessionSeconds > 0)
  const ids = new Set(rx.events().map((e) => e.data.session.id))
  assert.equal(ids.size, 1, 'one reference for the whole session, so a receiver can follow it')
  assert.doesNotMatch(rx.hits.map((h) => h.raw).join(''), new RegExp(sid), 'the player\'s own session id is never sent')
  assert.doesNotMatch(rx.hits.map((h) => h.raw).join(''), /Secret|\.mp4|token|mt=/i)
})

test('a direct-play session says so, and an episode carries show, season and episode', async (t) => {
  clock(t)
  const { store, rx } = await setup(t, ['playback.started'])
  webhooks.setPlaybackContext(() => ({ device: 'Android phone', playback: 'direct', media: { year: 2022, show: 'Severance', season: 1, episode: 3, ids: { tmdb: 95396, imdb: 'tt11280740', tvdb: 371980 } } }))
  history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Severance â€” S1E3', fileName: 'Severance/Season 1/Severance S01E03.mkv', kind: 'tv' })
  await webhooks.whenIdle()
  const d = rx.events()[0].data
  assert.equal(d.session.playback, 'direct')
  assert.equal(d.session.transcode, null)
  assert.deepEqual(d.media, { kind: 'tv', title: 'Severance â€” S1E3', year: 2022, show: 'Severance', season: 1, episode: 3, ids: { tmdb: 95396, imdb: 'tt11280740', tvdb: 371980 } })
})

test('a player that does not say whether it is paused is read from its position', async (t) => {
  const c = clock(t)
  const { store, rx } = await setup(t, ['playback.paused', 'playback.resumed', 'playback.progress'])
  const sid = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 15, duration: 6000 }) // 15 s of film in 15 s: playing
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 15.2, duration: 6000 }) // time passed, the film did not: paused
  c.advance(3000)
  history.updateSession(store, sid, { currentTime: 15.2, duration: 6000 }) // too soon to say anything new
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 15.2, duration: 6000 }) // still paused: not announced twice
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 30, duration: 6000 }) // moving again
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 3000, duration: 6000 }) // a seek is a jump, not a pause
  await webhooks.whenIdle()
  assert.deepEqual(names(rx), ['playback.paused', 'playback.resumed'])
})

test('a seek backwards is not a pause', async (t) => {
  const c = clock(t)
  const { store, rx } = await setup(t, ['playback.paused'])
  const sid = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 1000, duration: 6000 })
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 200, duration: 6000 })
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 0)
})

test('progress is a slow drip, about once a minute, and only while playing', async (t) => {
  const c = clock(t)
  const { store, rx } = await setup(t, ['playback.progress'])
  const sid = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  let pos = 0
  for (let i = 0; i < 16; i++) { c.advance(15000); pos += 15; history.updateSession(store, sid, { currentTime: pos, duration: 6000, state: 'playing' }) }
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 4, '16 reports over four minutes: one a minute')
  const before = rx.hits.length
  for (let i = 0; i < 8; i++) { c.advance(15000); history.updateSession(store, sid, { currentTime: pos, duration: 6000, state: 'paused' }) }
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, before, 'nothing while paused')
})

test('a private or limited profile, and a guest, is never announced anywhere: not to a webhook, not to a listener', async (t) => {
  clock(t)
  const { store, rx } = await setup(t)
  const heard = []
  webhooks.onEvent((m) => heard.push(m))
  for (const userId of ['hidden', 'kid', 'share:abc']) {
    const sid = history.startSession(store, { userId, userName: userId, title: 'Secret film', fileName: 'x.mp4', kind: 'movie' })
    history.updateSession(store, sid, { currentTime: 30, duration: 6000, state: 'paused' })
    history.updateSession(store, sid, { currentTime: 30, duration: 6000, state: 'stopped' })
  }
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 0)
  assert.equal(heard.length, 0)
})

test('an explicit stop ends the session at once, and it is announced once; silence does the same later', async (t) => {
  const c = clock(t)
  const { store, rx } = await setup(t, ['playback.stopped'])
  const a = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'A', fileName: 'A.mp4', kind: 'movie' })
  const b = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'B', fileName: 'B.mp4', kind: 'movie' })
  c.advance(10000)
  history.updateSession(store, a, { currentTime: 10, duration: 100, state: 'stopped' })
  history.updateSession(store, a, { currentTime: 10, duration: 100, state: 'stopped' })
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 1, 'a second stop report for the same session says nothing')
  c.advance(5 * 60 * 1000)
  assert.equal(webhooks.sweepPlayback(Date.now()), 1, 'B was never closed: silence stops it')
  await webhooks.whenIdle()
  assert.deepEqual(rx.events().map((e) => e.data.media.title), ['A', 'B'])
  assert.ok(b)
})

test('a session that began before anyone was listening is picked up quietly and still ends with a stop', async (t) => {
  const c = clock(t)
  const store = fakeStore({ watchedState: { schema: 1, migratedAt: 1, users: {} }, authUsers: USERS })
  const sid = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  const rx = await receiver()
  t.after(rx.close)
  await webhooks.create(store, { name: 'Late', url: rx.url, events: ['playback.started', 'playback.stopped'], allowPrivateNetwork: true })
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 15, duration: 6000, state: 'playing' })
  c.advance(15000)
  history.updateSession(store, sid, { currentTime: 30, duration: 6000, state: 'stopped' })
  await webhooks.whenIdle()
  assert.deepEqual(names(rx), ['playback.stopped'], 'no started (it happened before), and the stop is heard')
})

// ---- the formatted versions of these events reach the notification services -------------------

test('the new events go out in a hook\'s own format', async (t) => {
  clock(t)
  const { store, rx } = await setup(t, ['playback.started'])
  const made = await webhooks.create(store, { name: 'Phone', format: 'ntfy', url: rx.url + '-ntfy', events: ['playback.started'], allowPrivateNetwork: true })
  assert.equal(made.ok, true)
  webhooks.setPlaybackContext(() => ({ device: 'Living room TV', playback: 'direct', media: { ids: {} } }))
  history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  await webhooks.whenIdle()
  const ntfy = rx.hits.find((h) => h.headers.title)
  assert.ok(ntfy, 'the ntfy hook got a plain notification')
  assert.equal(ntfy.headers.title, 'Sam started Heat')
  assert.match(ntfy.raw, /Sam started watching Heat\. Living room TV \u00b7 direct play/)
  assert.ok(rx.hits.some((h) => h.raw.startsWith('{')), 'and the JSON hook got the envelope')
})

// ---- now playing over REST --------------------------------------------------------------------

test('GET /api/v1/now-playing: media ids, how it is served, one-way session reference, no file or address', async (t) => {
  const f = await createFixture(t)
  await fs.writeFile(path.join(f.cacheDir, 'external-ids.json'), JSON.stringify({ entries: { 'movie:949': { at: Date.now(), imdb: 'tt0113277', tvdb: null } } }))
  const key = (await f.admin('/api/admin/api-keys/create', { name: 'Dash', scopes: ['now-playing'] })).body.token
  const sid = history.startSession(f.store, { userId: 'member', userName: 'Member', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  history.updateSession(f.store, sid, { currentTime: 300, duration: 6000, state: 'playing' })
  const tv = history.startSession(f.store, { userId: 'admin2', userName: 'Second admin', title: 'Severance â€” S1E2', fileName: 'Severance/Season 1/Severance S01E02.mkv', kind: 'tv' })
  history.updateSession(f.store, tv, { currentTime: 60, duration: 3000 })

  const r = await f.call(key, '/api/v1/now-playing')
  assert.equal(r.status, 200)
  assert.equal(r.body.count, 2)
  const heat = r.body.items.find((i) => i.title === 'Heat')
  assert.deepEqual(heat.media, { year: 1995, show: null, season: null, episode: null, ids: { tmdb: 949, imdb: 'tt0113277', tvdb: null } })
  assert.equal(heat.playback, 'direct')
  assert.equal(heat.transcode, null)
  assert.equal(heat.state, 'playing')
  assert.equal(heat.positionSeconds, 300)
  assert.equal(heat.sessionId, webhooks.sessionRef(sid))
  const sev = r.body.items.find((i) => i.kind === 'tv')
  assert.equal(sev.media.show, 'Severance')
  assert.equal(sev.media.season, 1)
  assert.equal(sev.media.episode, 2)
  assert.doesNotMatch(r.text, /127\.0\.0\.1|\.mkv|\.mp4|Severance\/|userName/, 'no file name or address')
  assert.doesNotMatch(r.text, new RegExp(sid), 'not the raw session id')
})

// ---- the live stream --------------------------------------------------------------------------

// Opens an SSE request and gives back what has arrived so far, and a way to wait for a pattern.
function openStream(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      let text = ''
      const waiters = []
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d; for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(text) } })
      res.on('end', () => { for (const w of waiters) w.resolve(text) })
      const api = {
        status: res.statusCode,
        headers: res.headers,
        text: () => text,
        until: (re, ms = 4000) => new Promise((ok) => {
          const test = () => re.test(text)
          if (test()) return ok(text)
          const timer = setTimeout(() => ok(text), ms)
          waiters.push({ test, resolve: (v) => { clearTimeout(timer); ok(v) } })
        }),
        ended: () => new Promise((ok) => { if (res.complete || res.destroyed) ok(); else res.on('close', ok) }),
        close: () => { try { req.destroy() } catch {} }
      }
      resolve(api)
    })
    req.on('error', reject)
  })
}

const eventsIn = (text) => [...text.matchAll(/(?:id: (\d+)\n)?event: ([^\n]+)\ndata: ([^\n]+)\n\n/g)].map((m) => ({ id: m[1] ? Number(m[1]) : null, event: m[2], data: JSON.parse(m[3]) }))

test('GET /api/v1/events: a snapshot on connect, then each playback event as it happens', async (t) => {
  const f = await createFixture(t)
  const key = (await f.admin('/api/admin/api-keys/create', { name: 'Dash', scopes: ['now-playing'] })).body.token
  const s = await openStream(f.base + '/api/v1/events', { Authorization: 'Bearer ' + key })
  t.after(s.close)
  assert.equal(s.status, 200)
  assert.match(s.headers['content-type'], /^text\/event-stream/)
  assert.equal(s.headers['cache-control'], 'no-store, no-transform')
  const first = await s.until(/event: snapshot\ndata: .*\n\n/)
  assert.match(first, /^retry: 5000\n\n/)
  assert.equal(eventsIn(first)[0].data.count, 0)

  const sid = history.startSession(f.store, { userId: 'member', userName: 'Member', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  history.updateSession(f.store, sid, { currentTime: 30, duration: 6000, state: 'paused' })
  history.updateSession(f.store, sid, { currentTime: 30, duration: 6000, state: 'playing' })
  history.updateSession(f.store, sid, { currentTime: 40, duration: 6000, state: 'stopped' })
  const text = await s.until(/event: playback\.stopped/)
  const got = eventsIn(text).filter((e) => e.event.startsWith('playback.'))
  assert.deepEqual(got.map((e) => e.event), ['playback.started', 'playback.paused', 'playback.resumed', 'playback.stopped'])
  assert.deepEqual(got.map((e) => e.id), [1, 2, 3, 4], 'numbered, so a reconnect can ask for what it missed')
  assert.equal(got[0].data.event, 'playback.started', 'the same envelope the webhooks carry')
  assert.equal(got[0].data.data.user.name, 'Member')
  assert.equal(got[0].data.data.media.ids.tmdb, 949)
  assert.equal(got[0].data.data.session.playback, 'direct')
  assert.equal(got[3].data.data.positionSeconds, 40)

  // A reconnect with Last-Event-ID is sent only what came after it.
  const again = await openStream(f.base + '/api/v1/events', { Authorization: 'Bearer ' + key, 'Last-Event-ID': '2' })
  t.after(again.close)
  const replay = await again.until(/event: playback\.stopped/)
  assert.deepEqual(eventsIn(replay).filter((e) => e.event.startsWith('playback.')).map((e) => e.event), ['playback.resumed', 'playback.stopped'])
})

test('GET /api/v1/events: the owner\'s, needs the now-playing scope, and hides private and limited profiles', async (t) => {
  const f = await createFixture(t)
  const noScope = (await f.admin('/api/admin/api-keys/create', { name: 'Library only', scopes: ['library'] })).body.token
  assert.equal((await f.call(noScope, '/api/v1/events')).status, 403)
  assert.equal((await f.call(null, '/api/v1/events')).status, 401)
  assert.equal((await f.call('member', '/api/v1/events')).status, 403, 'a member\'s account token')
  assert.equal((await f.call('kid', '/api/v1/events')).status, 403)
  assert.equal((await f.call('owner', '/api/v1/events', { method: 'POST', body: {} })).status, 405)
  const head = await fetch(f.base + '/api/v1/events', { method: 'HEAD', headers: { Authorization: 'Bearer ' + f.tokens.owner } })
  assert.equal(head.status, 405, 'HEAD would open a stream nobody reads')

  const key = (await f.admin('/api/admin/api-keys/create', { name: 'Dash', scopes: ['now-playing'] })).body.token
  const s = await openStream(f.base + '/api/v1/events', { Authorization: 'Bearer ' + key })
  t.after(s.close)
  await s.until(/event: snapshot/)
  for (const userId of ['hidden', 'kid']) {
    const sid = history.startSession(f.store, { userId, userName: userId, title: 'Secret film', fileName: 'Aliens (1986).mkv', kind: 'movie' })
    history.updateSession(f.store, sid, { currentTime: 30, duration: 6000, state: 'stopped' })
  }
  const visible = history.startSession(f.store, { userId: 'member', userName: 'Member', title: 'Heat', fileName: 'Heat (1995).mp4', kind: 'movie' })
  history.updateSession(f.store, visible, { currentTime: 30, duration: 6000, state: 'stopped' })
  const text = await s.until(/event: playback\.stopped/)
  assert.deepEqual(eventsIn(text).filter((e) => e.event.startsWith('playback.')).map((e) => e.data.data.user.name), ['Member', 'Member'])
  assert.doesNotMatch(text, /Secret film|Hidden|Kid/)
})

test('GET /api/v1/events: a stream per key is capped, and it does not survive the key', async (t) => {
  const f = await createFixture(t)
  const made = await f.admin('/api/admin/api-keys/create', { name: 'Dash', scopes: ['now-playing'] })
  const key = made.body.token
  const open = []
  for (let i = 0; i < eventStream.DEFAULTS.maxPerPrincipal; i++) {
    const s = await openStream(f.base + '/api/v1/events', { Authorization: 'Bearer ' + key })
    open.push(s)
    assert.equal(s.status, 200)
  }
  t.after(() => open.forEach((s) => s.close()))
  const over = await f.call(key, '/api/v1/events')
  assert.equal(over.status, 429)
  assert.equal(over.body.error, 'too_many_streams')
  // Another key is another budget.
  const other = (await f.admin('/api/admin/api-keys/create', { name: 'Other', scopes: ['now-playing'] })).body.token
  const s2 = await openStream(f.base + '/api/v1/events', { Authorization: 'Bearer ' + other })
  t.after(s2.close)
  assert.equal(s2.status, 200)
})

// ---- the stream itself (its own timers, so a revoked key ends it in a blink) -------------------

test('eventStream: a stream ends by itself when its credential goes, and closeAll ends the rest', async (t) => {
  webhooks._reset()
  const streams = eventStream.createEventStream({ webhooks, snapshotEveryMs: 25, maxPerPrincipal: 2, maxConnections: 3 })
  let valid = true
  const srv = http.createServer((req, res) => {
    const out = streams.attach(req, res, { key: req.headers['x-key'] || 'k', snapshot: () => ({ ok: true, count: 0, items: [] }), isValid: () => valid })
    if (!out.ok) { res.writeHead(out.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: out.error })) }
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { streams.closeAll(); srv.closeAllConnections?.(); srv.close(resolve) }))
  const url = `http://127.0.0.1:${srv.address().port}/`

  const a = await openStream(url)
  assert.equal(webhooks.listenerCount(), 1, 'listening only because someone is connected')
  await a.until(/event: snapshot/)
  valid = false
  const finished = await Promise.race([a.ended().then(() => 'ended'), new Promise((r) => setTimeout(() => r('still open'), 2000))])
  assert.equal(finished, 'ended')
  assert.match(a.text(), /event: revoked\ndata: {"ok":false,"error":"unauthorized"}/)
  assert.equal(streams.size(), 0)
  assert.equal(webhooks.listenerCount(), 0, 'and not listening when nobody is')

  valid = true
  const one = await openStream(url, { 'X-Key': 'a' })
  const two = await openStream(url, { 'X-Key': 'a' })
  const capped = await openStream(url, { 'X-Key': 'a' })
  assert.equal(capped.status, 429, 'per key')
  const third = await openStream(url, { 'X-Key': 'b' })
  assert.equal(third.status, 200)
  const full = await openStream(url, { 'X-Key': 'c' })
  assert.equal(full.status, 503, 'per server')
  streams.closeAll()
  await Promise.all([one.ended(), two.ended(), third.ended()])
  assert.equal(streams.size(), 0)
})
