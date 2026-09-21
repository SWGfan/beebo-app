'use strict'
// Webhooks on a real server: the Admin routes and panel, and each event family arriving at a
// receiver from the real code paths (requests, playback, watched marks, library arrivals).
// Run: node --test test/webhooks-events.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const webhooks = require('../electron/webhooks')
const server = require('../electron/streamServer')
const { createFixture, webAdmin } = require('./helpers/publicApiFixture')

async function receiver() {
  const hits = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      hits.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200)
      res.end('ok')
    })
  })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${srv.address().port}/hook`,
    hits,
    events: () => hits.map((h) => JSON.parse(h.raw)),
    close: () => new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(resolve) })
  }
}

async function until(fn, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 40))
  }
}

test.beforeEach(() => {
  webhooks._reset()
  webhooks.configure({ retryDelaysMs: [5, 5], timeoutMs: 2000 })
})

async function addHook(f, rx, events, extra = {}) {
  const r = await f.admin('/api/admin/webhooks/create', { name: 'Receiver', url: rx.url, events, allowPrivateNetwork: true, ...extra })
  assert.equal(r.status, 200, r.text)
  return r.body
}

test('admin routes: LAN targets are refused unless ticked, the secret is shown once, and only admins reach them', async (t) => {
  const f = await createFixture(t)
  const rx = await receiver()
  t.after(rx.close)

  const refused = await f.admin('/api/admin/webhooks/create', { name: 'Home Assistant', url: 'http://192.168.1.50:8123/api/webhook/x', events: ['request.added'] })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error, 'blocked_private')
  const local = await f.admin('/api/admin/webhooks/create', { name: 'Same PC', url: rx.url, events: ['request.added'] })
  assert.equal(local.body.error, 'blocked_private', 'this computer counts as the private network')
  const meta = await f.admin('/api/admin/webhooks/create', { name: 'Metadata', url: 'http://169.254.169.254/latest', events: ['request.added'], allowPrivateNetwork: true })
  assert.equal(meta.body.error, 'blocked_address')
  assert.equal(f.data.webhooks, undefined)

  const made = await f.admin('/api/admin/webhooks/create', { name: 'Receiver', url: rx.url, events: ['request.added', 'playback.started'], allowPrivateNetwork: true })
  assert.equal(made.status, 200, made.text)
  assert.match(made.body.secret, /^beebo_whsec_/)
  assert.equal(made.body.hook.allowPrivateNetwork, true)

  const list = await f.admin('/api/admin/webhooks')
  assert.equal(list.status, 200)
  assert.equal(list.body.hooks.length, 1)
  assert.doesNotMatch(list.text, new RegExp(made.body.secret), 'the secret is not in the listing')
  assert.deepEqual(list.body.events.map((e) => e.id), webhooks.EVENTS.map((e) => e.id))

  // Non-admins, and an API key, get nowhere near it.
  assert.equal((await f.admin('/api/admin/webhooks', undefined, 'member')).status, 403)
  assert.equal((await f.admin('/api/admin/webhooks/create', { name: 'x', url: 'https://93.184.216.34/', events: ['request.added'] }, 'member')).status, 403)
  const key = await f.admin('/api/admin/api-keys/create', { name: 'k', scopes: ['library', 'history', 'now-playing'] })
  for (const [method, route, body] of [['GET', '/api/admin/webhooks'], ['POST', '/api/admin/webhooks/create', { name: 'x', url: 'https://93.184.216.34/', events: ['request.added'] }], ['POST', '/api/admin/webhooks/delete', { id: made.body.hook.id }], ['POST', '/api/admin/webhooks/test', { id: made.body.hook.id }]]) {
    const r = await f.call(key.body.token, route, { method, body })
    assert.equal(r.status, 403, route)
    assert.equal(r.body.error, 'api_key_scope')
  }
  assert.equal(f.data.webhooks.length, 1)
  assert.equal(rx.hits.length, 0, 'and no test was sent through a key')
})

test('admin routes: test event, turn off, new secret, delete, delivery log', async (t) => {
  const f = await createFixture(t)
  const rx = await receiver()
  t.after(rx.close)
  const { hook, secret } = await addHook(f, rx, ['request.added'])

  const test1 = await f.admin('/api/admin/webhooks/test', { id: hook.id })
  assert.equal(test1.status, 200)
  assert.equal(test1.body.delivery.ok, true)
  assert.equal(test1.body.delivery.status, 200)
  assert.equal(rx.events()[0].event, 'webhook.test')
  assert.equal(webhooks.verifySignature(secret, rx.hits[0].headers['x-beebo-signature'], rx.hits[0].raw), true)

  const off = await f.admin('/api/admin/webhooks/update', { id: hook.id, enabled: false })
  assert.equal(off.body.hook.enabled, false)
  const rot = await f.admin('/api/admin/webhooks/rotate-secret', { id: hook.id })
  assert.notEqual(rot.body.secret, secret)

  const log = await f.admin('/api/admin/webhooks')
  assert.equal(log.body.log.length, 1)
  assert.equal(log.body.log[0].event, 'webhook.test')
  assert.equal(log.body.log[0].hookName, 'Receiver')
  assert.doesNotMatch(JSON.stringify(log.body.log), /127\.0\.0\.1|beebo_whsec_/, 'neither the target address nor a secret is in the delivery log')
  assert.doesNotMatch(log.text, /beebo_whsec_/)

  assert.equal((await f.admin('/api/admin/webhooks/test', { id: 'nope' })).status, 404)
  assert.equal((await f.admin('/api/admin/webhooks/delete', { id: hook.id })).status, 200)
  assert.equal((await f.admin('/api/admin/webhooks/delete', { id: hook.id })).status, 404)
  assert.equal((await f.admin('/api/admin/webhooks/clear-log', {})).status, 200)
  assert.deepEqual((await f.admin('/api/admin/webhooks')).body.log, [])
})

test('request events from the real routes: added, declined, and approved (by the owner and by the library)', async (t) => {
  const f = await createFixture(t)
  const rx = await receiver()
  t.after(rx.close)
  await addHook(f, rx, ['request.added', 'request.approved', 'request.declined'])

  const ask = (title, tmdbId, year, note) => f.call('member', '/api/title-requests', { method: 'POST', body: { kind: 'movie', title, tmdbId, year, note } })
  const dune = await ask('Dune', 438631, 2021, 'family night')
  assert.equal(dune.status, 200, dune.text)
  const heat2 = await ask('Ronin', 2020, 1998)
  const tenet = await ask('Tenet', 577922, 2020)
  assert.equal(heat2.status, 200)
  assert.equal(tenet.status, 200)
  await until(() => rx.hits.length >= 3)
  const added = rx.events().filter((e) => e.event === 'request.added')
  assert.equal(added.length, 3)
  const d = added.find((e) => e.data.request.title === 'Dune')
  assert.equal(d.data.request.status, 'requested')
  assert.equal(d.data.request.tmdbId, 438631)
  assert.deepEqual(d.data.requester, { id: 'member', name: 'Member', note: 'family night' })
  assert.doesNotMatch(rx.hits[0].raw, /member@example\.test|token|password/i, 'no e-mail address or credential')
  // Asking again is not a new request.
  await ask('Dune', 438631, 2021, 'family night')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(rx.hits.length, 3)

  // The owner says no.
  const duneId = dune.body.request.id
  const declined = await f.call('owner', '/api/title-requests/dismiss', { method: 'POST', body: { id: duneId } })
  assert.equal(declined.status, 200)
  await until(() => rx.events().some((e) => e.event === 'request.declined'))
  const dec = rx.events().find((e) => e.event === 'request.declined')
  assert.equal(dec.data.request.id, duneId)
  assert.equal(dec.data.request.status, 'dismissed')

  // The owner marks another one found (Admin > Missing "sorted").
  const roninId = heat2.body.request.id
  const resolved = await f.admin('/api/admin/missing/resolve', { id: roninId })
  assert.equal(resolved.status, 200)
  await until(() => rx.events().some((e) => e.event === 'request.approved'))
  const app = rx.events().find((e) => e.event === 'request.approved')
  assert.equal(app.data.request.id, roninId)
  assert.equal(app.data.request.status, 'added')
  assert.equal(app.data.resolvedBy, 'owner')

  // And a title turning up in the library settles its request the way it always did.
  await fs.writeFile(path.join(f.moviesDir, 'Tenet (2020).mp4'), Buffer.alloc(2048, 7))
  let arrived = null
  for (let i = 0; i < 40 && !arrived; i++) {
    await f.call('member', '/api/title-requests')
    arrived = rx.events().find((e) => e.event === 'request.approved' && e.data.request.title === 'Tenet')
    if (!arrived) await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(arrived, 'the library rescan announced the arrival')
  assert.equal(arrived.data.resolvedBy, 'library')
  assert.equal(rx.events().filter((e) => e.event === 'request.approved' && e.data.request.title === 'Tenet').length, 1, 'once, not on every look')
})

test('playback events from the real routes: started for an ordinary member, never for a private or limited profile', async (t) => {
  const f = await createFixture(t)
  const rx = await receiver()
  t.after(rx.close)
  await addHook(f, rx, ['playback.started', 'playback.stopped', 'playback.watched'])
  const heat = server.encodeId('Heat (1995).mp4')

  const hiddenSession = await f.call('hidden', '/api/watch-session', { method: 'POST', body: { kind: 'movie', id: heat } })
  assert.equal(hiddenSession.status, 200, hiddenSession.text)
  const mine = await f.call('member', '/api/watch-session', { method: 'POST', body: { kind: 'movie', id: heat } })
  assert.equal(mine.status, 200)
  await until(() => rx.hits.length >= 1)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(rx.hits.length, 1, 'one announcement, for the one ordinary profile')
  const ev = rx.events()[0]
  assert.equal(ev.event, 'playback.started')
  assert.deepEqual(ev.data.user, { id: 'member', name: 'Member' })
  assert.equal(ev.data.media.kind, 'movie')
  assert.equal(ev.data.media.title, 'Heat')
  assert.doesNotMatch(rx.hits[0].raw, /\.mp4|mt=|Bearer|beebo_|Movies|tmpdir|beebo-public-api/i, 'no file name, path or token')

  // Playing to the end marks it watched, once.
  for (const currentTime of [5000, 5900, 5950]) {
    await f.call('member', '/api/progress', { method: 'POST', body: { sessionId: mine.body.sessionId, currentTime, duration: 6000 } })
  }
  await until(() => rx.events().some((e) => e.event === 'playback.watched'))
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(rx.events().filter((e) => e.event === 'playback.watched').length, 1)

  // Ticking things by hand: one event for the film, and the private profile's tick is silent.
  const alien = server.encodeId('Alien (1979).mp4')
  assert.equal((await f.call('hidden', '/api/watched/movie', { method: 'POST', body: { id: alien, watched: true } })).status, 200)
  assert.equal((await f.call('member', '/api/watched/movie', { method: 'POST', body: { id: alien, watched: true } })).status, 200)
  await f.call('member', '/api/watched/movie', { method: 'POST', body: { id: alien, watched: true } })
  await until(() => rx.events().some((e) => e.data.source === 'manual'))
  await new Promise((r) => setTimeout(r, 150))
  const manual = rx.events().filter((e) => e.data.source === 'manual')
  assert.equal(manual.length, 1, 'ticking it a second time changes nothing, so announces nothing')
  assert.equal(manual[0].data.media.title, 'Alien')
})

test('library.item_added: the first look takes a baseline, later arrivals are announced without paths', async (t) => {
  const f = await createFixture(t)
  const rx = await receiver()
  t.after(rx.close)
  assert.equal(await f.info.webhooks.announceLibrary(), 0, 'nobody subscribed: nothing to do')
  assert.equal(f.data.webhookLibrarySeen, undefined)
  await addHook(f, rx, ['library.item_added'])
  await until(() => Array.isArray(f.data.webhookLibrarySeen))
  assert.ok(Array.isArray(f.data.webhookLibrarySeen), 'turning the webhook on took the baseline')
  assert.equal(f.data.webhookLibrarySeen.length, 5, '3 films + 2 episodes, as short fingerprints')
  assert.equal(await f.info.webhooks.announceLibrary(), 0, 'nothing new since')
  assert.equal(rx.hits.length, 0, 'the existing library was not announced')

  await fs.writeFile(path.join(f.moviesDir, 'Ronin (1998).mp4'), Buffer.alloc(2048, 5))
  await fs.writeFile(path.join(f.tvDir, 'Severance', 'Season 1', 'Severance S01E03.mkv'), Buffer.alloc(2048, 6))
  let sent = 0
  for (let i = 0; i < 40 && sent < 2; i++) {
    sent += await f.info.webhooks.announceLibrary()
    if (sent < 2) await new Promise((r) => setTimeout(r, 100))
  }
  assert.equal(sent, 2)
  await until(() => rx.hits.length >= 2)
  const items = rx.events().map((e) => e.data.item).sort((a, b) => a.kind.localeCompare(b.kind))
  assert.equal(rx.events()[0].event, 'library.item_added')
  assert.equal(items[0].kind, 'episode')
  assert.equal(items[0].season, 1)
  assert.equal(items[0].episode, 3)
  assert.equal(items[1].kind, 'movie')
  assert.equal(items[1].title, 'Ronin')
  assert.doesNotMatch(rx.hits.map((h) => h.raw).join(''), /\.mkv|\.mp4|Season 1|beebo-public-api|Movies/, 'no file names or paths')
  assert.equal(await f.info.webhooks.announceLibrary(), 0, 'and each only once')
})

test('web admin: Webhooks tab adds one (LAN box and warning), shows the secret once, tests, turns off and removes', async (t) => {
  const f = await createFixture(t)
  const web = webAdmin(f)
  if (!web) { t.skip('openssl not available'); return }
  const rx = await receiver()
  t.after(rx.close)

  const page = await web('GET', '/admin?tab=webhooks')
  assert.equal(page.status, 200)
  assert.match(page.body, /Allow a target on my home network/)
  assert.match(page.body, /Off by default/)
  assert.match(page.body, /request\.added/)
  assert.match(page.body, /No webhooks yet/)

  const refused = await web('POST', '/admin/webhooks/create', { tab: 'webhooks', name: 'HA', url: rx.url, 'event_request.added': '1' })
  assert.equal(refused.status, 303)
  assert.match((await web('GET', refused.headers.location)).body, /home network\. Nothing was saved/)
  assert.equal(f.data.webhooks, undefined)
  const none = await web('POST', '/admin/webhooks/create', { tab: 'webhooks', name: 'HA', url: rx.url, allowPrivateNetwork: '1' })
  assert.match((await web('GET', none.headers.location)).body, /Tick at least one event/)

  const made = await web('POST', '/admin/webhooks/create', { tab: 'webhooks', name: 'HA', url: rx.url, 'event_request.added': '1', 'event_playback.started': '1', allowPrivateNetwork: '1' })
  assert.equal(made.status, 303)
  const shown = await web('GET', made.headers.location)
  const secret = /(beebo_whsec_[A-Za-z0-9_-]{43})/.exec(shown.body)
  assert.ok(secret, 'the secret is on the page it lands on')
  assert.match(shown.body, /can't be shown again/)
  const again = await web('GET', made.headers.location)
  assert.doesNotMatch(again.body, /beebo_whsec_/, 'consumed on display')
  const tab = await web('GET', '/admin?tab=webhooks')
  assert.doesNotMatch(tab.body, /beebo_whsec_/, 'and never part of the tab itself')
  assert.match(tab.body, /May send to your home network/)
  assert.match(tab.body, /Send a test event/)

  const id = f.data.webhooks[0].id
  const sent = await web('POST', '/admin/webhooks/test', { tab: 'webhooks', id })
  assert.match((await web('GET', sent.headers.location)).body, /Test delivered: the other end answered HTTP 200/)
  assert.equal(webhooks.verifySignature(secret[1], rx.hits[0].headers['x-beebo-signature'], rx.hits[0].raw), true)
  assert.match((await web('GET', '/admin?tab=webhooks')).body, /Delivered \(HTTP 200\)/, 'the delivery log shows it')

  const off = await web('POST', '/admin/webhooks/toggle', { tab: 'webhooks', id, enabled: '0' })
  assert.match((await web('GET', off.headers.location)).body, /turned off/i)
  assert.equal(f.data.webhooks[0].enabled, false)
  const gone = await web('POST', '/admin/webhooks/delete', { tab: 'webhooks', id })
  assert.equal(gone.status, 303)
  assert.equal(f.data.webhooks.length, 0)
})
