'use strict'
// Outbound webhooks (electron/webhooks.js): SSRF guard, signing, retry-then-drop, never blocking,
// the delivery log, and what a payload may carry. No Electron, no external network: targets are
// receivers on 127.0.0.1, which is why those webhooks are created with the LAN opt-in ticked.
// Run: node --test test/webhooks.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const crypto = require('node:crypto')
const dns = require('node:dns')
const webhooks = require('../electron/webhooks')

const fakeStore = (initial = {}) => {
  const data = { ...initial }
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
}

async function receiver(handler) {
  const hits = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const hit = { method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') }
      hits.push(hit)
      handler(hit, res, hits.length)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/hook`, port: server.address().port, hits, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }) }
}

const ok200 = (_hit, res) => { res.writeHead(200); res.end('ok') }

test.beforeEach(() => {
  webhooks._reset()
  webhooks.configure({ retryDelaysMs: [5, 5], timeoutMs: 2000, maxConcurrent: 4, maxQueue: 200 })
})

async function hookFor(store, url, extra = {}) {
  const out = await webhooks.create(store, { name: 'Test hook', url, events: ['request.added'], allowPrivateNetwork: true, ...extra })
  assert.equal(out.ok, true, JSON.stringify(out))
  return out
}

test('classifyAddress: public, LAN and never-allowed ranges, including IPv6 disguises', () => {
  const cls = webhooks.classifyAddress
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(cls(ip), 'public', ip)
  for (const ip of ['127.0.0.1', '127.9.9.9', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1', '::1', 'fd12:3456:789a::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:192.168.0.9', '::ffff:7f00:1', '64:ff9b::a00:1']) assert.equal(cls(ip), 'lan', ip)
  for (const ip of ['0.0.0.0', '0.1.2.3', '169.254.169.254', '169.254.0.1', '192.0.0.192', '224.0.0.1', '255.255.255.255', '240.0.0.1', '::', 'fe80::1', 'fe80::a00:27ff:fe4e:66a1', 'ff02::1', 'fd00:ec2::254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '2002:a9fe:a9fe::1']) assert.equal(cls(ip), 'blocked', ip)
  for (const junk of ['', 'not-an-ip', '999.1.1.1', '1.2.3', null, undefined]) assert.equal(cls(junk), 'blocked', String(junk))
})

test('parseTargetUrl: http and https only, no credentials, sane length', () => {
  const p = webhooks.parseTargetUrl
  assert.equal(p('https://example.com/hook').ok, true)
  assert.equal(p('http://192.168.1.5:8123/api/webhook/abc').ok, true)
  for (const bad of ['', '   ', 'ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x', 'data:text/plain,hi', 'example.com/hook', 'http://', 'http://user:pw@example.com/', 'http://user@example.com/', 'https://' + 'a'.repeat(2100), null, undefined]) {
    assert.equal(p(bad).ok, false, String(bad).slice(0, 40))
  }
})

test('a target on this computer or the home network is refused by default; link-local and metadata never', async () => {
  const store = fakeStore()
  const events = ['request.added']
  const tryCreate = (url, allowPrivateNetwork) => webhooks.create(store, { name: 'x', url, events, allowPrivateNetwork })
  for (const url of ['http://127.0.0.1:9/hook', 'http://127.0.0.1/', 'http://192.168.1.50:8123/api/webhook/x', 'http://10.0.0.5/', 'http://172.16.4.4/', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://localhost:8123/', 'http://LOCALHOST/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://100.64.1.1/']) {
    const r = await tryCreate(url, false)
    assert.equal(r.ok, false, url)
    assert.equal(r.error, 'blocked_private', url)
  }
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'http://0.0.0.0/', 'http://[::]/', 'http://224.0.0.1/', 'http://[::ffff:169.254.169.254]/', 'http://2852039166/']) {
    for (const allow of [false, true]) {
      const r = await tryCreate(url, allow)
      assert.equal(r.ok, false, `${url} allow=${allow}`)
      assert.equal(r.error, 'blocked_address', `${url} allow=${allow}`)
    }
  }
  assert.equal(store.data.webhooks, undefined, 'nothing was saved')
  // The opt-in lets a home target through, and only that.
  const lan = await tryCreate('http://192.168.1.50:8123/api/webhook/x', true)
  assert.equal(lan.ok, true)
  assert.equal(lan.hook.allowPrivateNetwork, true)
  const pub = await tryCreate('https://93.184.216.34/hook', false)
  assert.equal(pub.ok, true)
  assert.equal(pub.hook.allowPrivateNetwork, false)
})

test('a name is judged by every address it resolves to: one private answer refuses it', async (t) => {
  const real = dns.lookup
  t.after(() => { dns.lookup = real })
  const answers = {
    'good.example.test': [{ address: '93.184.216.34', family: 4 }],
    'mixed.example.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }],
    'meta.example.test': [{ address: '169.254.169.254', family: 4 }],
    'v6.example.test': [{ address: '::1', family: 6 }],
    'home.example.test': [{ address: '192.168.1.20', family: 4 }]
  }
  dns.lookup = (host, opts, cb) => {
    const list = answers[host]
    if (!list) return cb(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }))
    cb(null, list)
  }
  const r = (host, allow) => webhooks.resolveTarget(`https://${host}/x`, { allowPrivateNetwork: allow })
  assert.equal((await r('good.example.test', false)).ok, true)
  assert.equal((await r('mixed.example.test', false)).error, 'blocked_private')
  assert.equal((await r('mixed.example.test', true)).ok, true, 'with the opt-in a mixed answer is a LAN answer')
  assert.equal((await r('meta.example.test', true)).error, 'blocked_address')
  assert.equal((await r('v6.example.test', false)).error, 'blocked_private')
  assert.equal((await r('home.example.test', false)).error, 'blocked_private')
  assert.equal((await r('gone.example.test', false)).error, 'unresolvable')

  // And a delivery re-judges: a target that was fine when saved but resolves to a private address
  // now (rebinding) is refused at send time, with nothing connected.
  const store = fakeStore()
  answers['rebind.example.test'] = [{ address: '93.184.216.34', family: 4 }]
  const hook = await webhooks.create(store, { name: 'Rebinder', url: 'https://rebind.example.test/x', events: ['request.added'] })
  assert.equal(hook.ok, true)
  answers['rebind.example.test'] = [{ address: '127.0.0.1', family: 4 }]
  assert.equal(webhooks.emit(store, 'request.added', { n: 1 }), 1)
  await webhooks.whenIdle()
  const log = webhooks.getLog(store)
  assert.equal(log.length, 1)
  assert.equal(log[0].ok, false)
  assert.match(log[0].error, /private network/)
  assert.equal(log[0].attempts, 1, 'a refusal is final, not retried')
})

test('delivery: signed POST whose signature verifies with the documented algorithm', async (t) => {
  const store = fakeStore()
  const rx = await receiver(ok200)
  t.after(rx.close)
  const { secret } = await hookFor(store, rx.url)
  assert.match(secret, /^beebo_whsec_[A-Za-z0-9_-]{43}$/)
  const data = { request: { id: 'r1', title: 'Dune' }, requester: { id: 'u1', name: 'Sam' } }
  assert.equal(webhooks.emit(store, 'request.added', data), 1)
  await webhooks.whenIdle()

  assert.equal(rx.hits.length, 1)
  const hit = rx.hits[0]
  assert.equal(hit.method, 'POST')
  assert.equal(hit.url, '/hook')
  assert.equal(hit.headers['content-type'], 'application/json')
  assert.equal(hit.headers['x-beebo-event'], 'request.added')
  assert.match(hit.headers['x-beebo-delivery'], /^[0-9a-f-]{36}$/)
  const payload = JSON.parse(hit.raw)
  assert.deepEqual(Object.keys(payload).sort(), ['data', 'event', 'timestamp'])
  assert.equal(payload.event, 'request.added')
  assert.equal(new Date(payload.timestamp).toISOString(), payload.timestamp)
  assert.deepEqual(payload.data, data)

  // The receiver's side, written out independently of webhooks.js: t=<unix>,v1=<hmac-sha256 over "<t>.<rawBody>">.
  const header = hit.headers['x-beebo-signature']
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)
  assert.ok(m, header)
  assert.ok(Math.abs(Number(m[1]) - Date.now() / 1000) < 10)
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${hit.raw}`).digest('hex')
  assert.equal(m[2], expected)
  assert.equal(webhooks.verifySignature(secret, header, hit.raw), true)
  // Tampering, the wrong secret, an old timestamp: all fail.
  assert.equal(webhooks.verifySignature(secret, header, hit.raw.replace('Dune', 'Duna')), false)
  assert.equal(webhooks.verifySignature('beebo_whsec_wrong', header, hit.raw), false)
  assert.equal(webhooks.verifySignature(secret, header, hit.raw, { now: Date.now() + 10 * 60 * 1000 }), false)
  assert.equal(webhooks.verifySignature(secret, 'garbage', hit.raw), false)
  assert.equal(webhooks.verifySignature(secret, `t=${m[1]},v1=${'0'.repeat(64)}`, hit.raw), false)

  const log = webhooks.getLog(store)
  assert.equal(log.length, 1)
  assert.deepEqual({ ok: log[0].ok, status: log[0].status, attempts: log[0].attempts, event: log[0].event, hookName: log[0].hookName }, { ok: true, status: 200, attempts: 1, event: 'request.added', hookName: 'Test hook' })
})

test('the secret is shown once: never in the list, never in the log, rotating retires the old one', async (t) => {
  const store = fakeStore()
  const rx = await receiver(ok200)
  t.after(rx.close)
  const { hook, secret } = await hookFor(store, rx.url)
  assert.ok(!JSON.stringify(webhooks.list(store)).includes(secret))
  assert.ok(!('secret' in webhooks.list(store)[0]))
  webhooks.emit(store, 'request.added', {})
  await webhooks.whenIdle()
  assert.ok(!JSON.stringify(webhooks.getLog(store)).includes(secret))

  const rotated = webhooks.rotateSecret(store, hook.id)
  assert.equal(rotated.ok, true)
  assert.notEqual(rotated.secret, secret)
  assert.ok(!JSON.stringify(rotated.hook).includes(rotated.secret))
  webhooks.emit(store, 'request.added', {})
  await webhooks.whenIdle()
  const second = rx.hits[1]
  assert.equal(webhooks.verifySignature(rotated.secret, second.headers['x-beebo-signature'], second.raw), true)
  assert.equal(webhooks.verifySignature(secret, second.headers['x-beebo-signature'], second.raw), false)
  assert.equal(webhooks.rotateSecret(store, 'nope').error, 'not_found')
})

test('retry then drop: a failing target gets 3 attempts, is logged, and is then left alone', async (t) => {
  const store = fakeStore()
  const rx = await receiver((_h, res) => { res.writeHead(500); res.end('boom') })
  t.after(rx.close)
  await hookFor(store, rx.url)
  webhooks.emit(store, 'request.added', { n: 1 })
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 3, 'exactly three attempts')
  assert.equal(new Set(rx.hits.map((h) => h.headers['x-beebo-delivery'])).size, 1, 'one delivery id across attempts')
  assert.equal(new Set(rx.hits.map((h) => h.raw)).size, 1, 'the same body every time')
  const log = webhooks.getLog(store)
  assert.equal(log.length, 1, 'one entry for the delivery, not one per attempt')
  assert.deepEqual({ ok: log[0].ok, status: log[0].status, attempts: log[0].attempts, error: log[0].error }, { ok: false, status: 500, attempts: 3, error: 'HTTP 500' })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(rx.hits.length, 3, 'dropped: nothing further is sent')
})

test('retry: a target that recovers on the third try is delivered; a 4xx is final at once', async (t) => {
  const store = fakeStore()
  const flaky = await receiver((_h, res, n) => { res.writeHead(n < 3 ? 503 : 204); res.end() })
  const picky = await receiver((_h, res) => { res.writeHead(400); res.end() })
  t.after(flaky.close); t.after(picky.close)
  await hookFor(store, flaky.url, { name: 'Flaky' })
  webhooks.emit(store, 'request.added', {})
  await webhooks.whenIdle()
  assert.equal(flaky.hits.length, 3)
  assert.deepEqual({ ok: webhooks.getLog(store)[0].ok, attempts: webhooks.getLog(store)[0].attempts, status: webhooks.getLog(store)[0].status }, { ok: true, attempts: 3, status: 204 })

  const store2 = fakeStore()
  await hookFor(store2, picky.url, { name: 'Picky' })
  webhooks.emit(store2, 'request.added', {})
  await webhooks.whenIdle()
  assert.equal(picky.hits.length, 1, 'a 400 means "no", so it is not retried')
  assert.equal(webhooks.getLog(store2)[0].attempts, 1)
})

test('never blocks the caller: emit returns at once even when the target hangs, and the timeout is short', async (t) => {
  const store = fakeStore()
  webhooks.configure({ timeoutMs: 150, retryDelaysMs: [5, 5] })
  const rx = await receiver(() => { /* never answers */ })
  t.after(rx.close)
  await hookFor(store, rx.url)
  const t0 = process.hrtime.bigint()
  webhooks.emit(store, 'request.added', {})
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.ok(ms < 50, `emit took ${ms} ms`)
  assert.equal(webhooks.getLog(store).length, 0, 'nothing has been attempted yet: it happens off the caller\'s path')
  await webhooks.whenIdle()
  const log = webhooks.getLog(store)
  assert.equal(log[0].ok, false)
  assert.equal(log[0].error, 'timeout')
  assert.equal(log[0].attempts, 3)
})

test('emit never throws, whatever it is handed', () => {
  const broken = { get: () => { throw new Error('store down') }, set: () => { throw new Error('store down') } }
  assert.equal(webhooks.emit(broken, 'request.added', {}), 0)
  assert.equal(webhooks.emit(null, 'request.added', {}), 0)
  assert.equal(webhooks.emit(fakeStore(), 'no.such.event', {}), 0)
  assert.equal(webhooks.emit(fakeStore(), 'request.added', { circular: (() => { const o = {}; o.o = o; return o })() }), 0)
  assert.equal(webhooks.notePlayback(broken, 'started', { userId: 'u' }), undefined)
})

test('redirects are not followed', async (t) => {
  const store = fakeStore()
  const target = await receiver(ok200)
  const redirector = await receiver((_h, res) => { res.writeHead(302, { Location: target.url }); res.end() })
  t.after(target.close); t.after(redirector.close)
  await hookFor(store, redirector.url)
  webhooks.emit(store, 'request.added', {})
  await webhooks.whenIdle()
  assert.equal(target.hits.length, 0, 'the redirect target was never contacted')
  assert.equal(redirector.hits.length, 1, 'and a redirect is not retried')
  const log = webhooks.getLog(store)[0]
  assert.equal(log.ok, false)
  assert.match(log.error, /redirects are not followed/)
})

test('the response is size-capped and never stored', async (t) => {
  const store = fakeStore()
  const marker = 'SECRET-RESPONSE-BODY-MARKER'
  let sentBytes = 0
  const rx = await receiver((_h, res) => {
    res.writeHead(200)
    const chunk = Buffer.from(marker.repeat(400))
    const timer = setInterval(() => { sentBytes += chunk.length; if (res.destroyed || !res.write(chunk)) clearInterval(timer) }, 1)
    res.on('close', () => clearInterval(timer))
    setTimeout(() => { clearInterval(timer); res.end() }, 5000).unref()
  })
  t.after(rx.close)
  await hookFor(store, rx.url)
  const t0 = Date.now()
  webhooks.emit(store, 'request.added', {})
  await webhooks.whenIdle()
  assert.ok(Date.now() - t0 < 3000, 'gave up reading long before the endless body ended')
  assert.ok(sentBytes < 2 * 1024 * 1024, 'stopped pulling the body')
  assert.equal(webhooks.getLog(store)[0].ok, true)
  assert.ok(!JSON.stringify(store.data).includes(marker), 'no part of the response is kept anywhere')
})

test('a disabled or unsubscribed webhook is sent nothing; the log is capped at 100', async (t) => {
  const store = fakeStore()
  const rx = await receiver(ok200)
  t.after(rx.close)
  const { hook } = await hookFor(store, rx.url, { events: ['request.approved'] })
  assert.equal(webhooks.emit(store, 'request.added', {}), 0, 'not subscribed to it')
  assert.equal((await webhooks.update(store, hook.id, { enabled: false })).hook.enabled, false)
  assert.equal(webhooks.emit(store, 'request.approved', {}), 0, 'turned off')
  await webhooks.update(store, hook.id, { enabled: true })
  for (let i = 0; i < 120; i++) webhooks.emit(store, 'request.approved', { i })
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 120)
  assert.equal(webhooks.getLog(store).length, webhooks.MAX_LOG)
  assert.equal(webhooks.MAX_LOG, 100)
  webhooks.clearLog(store)
  assert.equal(webhooks.getLog(store).length, 0)
})

test('config validation: names, events, count, and an edit re-checks the address', async () => {
  const store = fakeStore()
  const base = { name: 'x', url: 'https://93.184.216.34/h', events: ['request.added'] }
  assert.equal((await webhooks.create(store, { ...base, name: '' })).error, 'bad_name')
  assert.equal((await webhooks.create(store, { ...base, name: 'y'.repeat(61) })).error, 'bad_name')
  assert.equal((await webhooks.create(store, { ...base, events: [] })).error, 'bad_events')
  assert.equal((await webhooks.create(store, { ...base, events: ['request.added', 'admin.everything'] })).error, 'bad_events')
  assert.equal((await webhooks.create(store, { ...base, events: ['webhook.test'] })).error, 'bad_events', 'the test event is not a subscription')
  assert.equal((await webhooks.create(store, { ...base, url: 'ftp://x/y' })).error, 'bad_url')
  const made = await webhooks.create(store, base)
  assert.equal(made.ok, true)
  assert.equal((await webhooks.update(store, made.hook.id, { url: 'http://192.168.0.9/x' })).error, 'blocked_private')
  assert.equal((await webhooks.update(store, made.hook.id, { url: 'http://192.168.0.9/x', allowPrivateNetwork: true })).ok, true)
  assert.equal((await webhooks.update(store, made.hook.id, { allowPrivateNetwork: false })).error, 'blocked_private', 'un-ticking the box on a LAN target is refused, not silently kept')
  assert.equal((await webhooks.update(store, 'nope', {})).error, 'not_found')
  for (let i = 1; i < webhooks.MAX_HOOKS; i++) assert.equal((await webhooks.create(store, base)).ok, true)
  assert.equal((await webhooks.create(store, base)).error, 'too_many_hooks')
  assert.equal(webhooks.remove(store, made.hook.id).ok, true)
  assert.equal(webhooks.remove(store, made.hook.id).error, 'not_found')
})

test('send test event: one attempt, answered to the caller, logged', async (t) => {
  const store = fakeStore()
  const good = await receiver(ok200)
  const bad = await receiver((_h, res) => { res.writeHead(500); res.end() })
  t.after(good.close); t.after(bad.close)
  const a = await hookFor(store, good.url, { name: 'Good', events: ['library.item_added'] })
  const b = await hookFor(store, bad.url, { name: 'Bad' })
  const okRes = await webhooks.sendTest(store, a.hook.id)
  assert.equal(okRes.ok, true)
  assert.equal(okRes.delivery.ok, true)
  assert.equal(okRes.delivery.status, 200)
  const body = JSON.parse(good.hits[0].raw)
  assert.equal(body.event, 'webhook.test')
  assert.equal(good.hits[0].headers['x-beebo-event'], 'webhook.test')
  assert.equal(webhooks.verifySignature(a.secret, good.hits[0].headers['x-beebo-signature'], good.hits[0].raw), true)
  const badRes = await webhooks.sendTest(store, b.hook.id)
  assert.equal(badRes.delivery.ok, false)
  assert.equal(badRes.delivery.error, 'HTTP 500')
  assert.equal(bad.hits.length, 1, 'a test is not retried')
  assert.equal((await webhooks.sendTest(store, 'nope')).error, 'not_found')
  assert.equal(webhooks.getLog(store).length, 2)
})

test('request payloads: the change in status, the people involved, and no e-mail addresses', () => {
  const row = {
    id: 'r1', kind: 'movie', title: 'Dune', year: 2021, tmdbId: 438631, source: 'request', firstSeenAt: 1000, resolved: true, addedAt: 2000, resolvedBy: 'library',
    requestedBy: [{ userId: 'u1', userName: 'Sam', at: 1000, note: 'please!', email: 'sam@example.test' }]
  }
  const d = webhooks.requestData(row)
  assert.equal(d.status, 'added')
  assert.deepEqual(d.requesters, [{ id: 'u1', name: 'Sam', note: 'please!' }])
  assert.doesNotMatch(JSON.stringify(d), /example\.test|email/)
})

test('requestTransition: the same decision requestersToNotify makes', () => {
  const tr = require('../electron/titleRequests')
  const open = { id: 'a', kind: 'movie', title: 'X', requestedBy: [{ userId: 'u1' }] }
  const found = tr.resolveRow(open)
  const denied = tr.dismissRow(open)
  assert.equal(tr.requestTransition(open, found), 'added')
  assert.equal(tr.requestTransition(open, denied), 'dismissed')
  assert.equal(tr.requestTransition(open, open), null)
  assert.equal(tr.requestTransition(found, tr.resolveRow(found)), null, 'a repeat is not a transition')
  assert.equal(tr.requestTransition(null, found), null)
  assert.deepEqual(tr.requestersToNotify(open, found), [{ userId: 'u1' }])
  assert.deepEqual(tr.requestersToNotify(open, open), [])
  const store = fakeStore()
  assert.equal(webhooks.emitRequestTransition(store, open, open), 0)
})

test('playback: started, stopped by silence, watched at the end - and never for a private or limited profile', async (t) => {
  const history = require('../electron/history')
  const parental = require('../electron/parentalControls')
  const store = fakeStore({
    // Already migrated, so the first finished session is a real transition rather than a migrated row.
    watchedState: { schema: 1, migratedAt: 1, users: {} },
    authUsers: [
      { id: 'u1', name: 'Sam', username: 'sam', status: 'approved', adult: true },
      { id: 'hidden', name: 'Hidden', username: 'hidden', status: 'approved', adult: true, viewingHistoryPrivate: true },
      { id: 'kid', name: 'Kid', username: 'kid', status: 'approved' }
    ]
  })
  parental.setPolicy(store, 'kid', parental.presetPolicy('kids'))
  const rx = await receiver(ok200)
  t.after(rx.close)
  await hookFor(store, rx.url, { events: ['playback.started', 'playback.stopped', 'playback.watched'] })

  const secretFile = 'C:\\Users\\Nick\\Movies\\Secret Folder\\Heat (1995).mp4'
  const sid = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: secretFile, kind: 'movie' })
  history.startSession(store, { userId: 'hidden', userName: 'Hidden', title: 'Private film', fileName: 'p.mp4', kind: 'movie' })
  history.startSession(store, { userId: 'kid', userName: 'Kid', title: 'Kid film', fileName: 'k.mp4', kind: 'movie' })
  history.startSession(store, { userId: 'share:abc', userName: 'Guest', title: 'Guest film', fileName: 'g.mp4', kind: 'movie' })
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 1, 'only the ordinary profile is announced')
  const started = JSON.parse(rx.hits[0].raw)
  assert.equal(started.event, 'playback.started')
  assert.deepEqual(started.data.user, { id: 'u1', name: 'Sam' })
  // The ids are there (null until the server knows them) so a receiver's parser never has to guess.
  assert.deepEqual(started.data.media, { kind: 'movie', title: 'Heat', year: null, ids: { tmdb: null, imdb: null, tvdb: null } })
  assert.equal(started.data.session.state, 'playing')
  assert.equal(started.data.session.playback, 'direct')
  assert.match(started.data.session.id, /^[A-Za-z0-9_-]{12}$/)
  assert.notEqual(started.data.session.id, sid, 'the player\'s own session id is never handed out')
  assert.doesNotMatch(rx.hits[0].raw, /Secret Folder|Heat \(1995\)|\.mp4|Users|mt=|token/i, 'no file path, file name or token')

  history.updateSession(store, sid, { currentTime: 600, duration: 6000 })
  assert.equal(webhooks.sweepPlayback(Date.now() + 30 * 1000), 0, 'still playing')
  assert.equal(webhooks.sweepPlayback(Date.now() + 5 * 60 * 1000), 1, 'silent for minutes: stopped')
  await webhooks.whenIdle()
  const stopped = JSON.parse(rx.hits[1].raw)
  assert.equal(stopped.event, 'playback.stopped')
  assert.equal(stopped.data.positionSeconds, 600)
  assert.equal(stopped.data.durationSeconds, 6000)
  assert.equal(stopped.data.percent, 10)
  assert.equal(webhooks.sweepPlayback(Date.now() + 10 * 60 * 1000), 0, 'announced once')

  const sid2 = history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Alien', fileName: 'Alien (1979).mp4', kind: 'movie' })
  history.updateSession(store, sid2, { currentTime: 5900, duration: 6000 })
  history.updateSession(store, sid2, { currentTime: 5950, duration: 6000 })
  await webhooks.whenIdle()
  const watched = rx.hits.map((h) => JSON.parse(h.raw)).filter((p) => p.event === 'playback.watched')
  assert.equal(watched.length, 1, 'crossing the finished line announces once, not on every report after it')
  assert.equal(watched[0].data.source, 'playback')
  assert.equal(watched[0].data.media.title, 'Alien')
  assert.equal(rx.hits.map((h) => JSON.parse(h.raw)).filter((p) => p.data.user && p.data.user.id !== 'u1').length, 0)
})

test('playback events are not even tracked when nothing subscribes', () => {
  const history = require('../electron/history')
  const store = fakeStore({ authUsers: [{ id: 'u1', name: 'Sam', username: 'sam', status: 'approved' }] })
  history.startSession(store, { userId: 'u1', userName: 'Sam', title: 'Heat', fileName: 'Heat.mp4', kind: 'movie' })
  assert.equal(webhooks.sweepPlayback(Date.now() + 10 * 60 * 1000), 0)
})

test('manual watched marks: one event per item that flipped, capped, private profiles skipped', async (t) => {
  const store = fakeStore({ authUsers: [{ id: 'u1', name: 'Sam', username: 'sam', status: 'approved' }, { id: 'hidden', name: 'H', username: 'h', status: 'approved', viewingHistoryPrivate: true }] })
  const rx = await receiver(ok200)
  t.after(rx.close)
  await hookFor(store, rx.url, { events: ['playback.watched'] })
  const items = Array.from({ length: 40 }, (_, i) => ({ kind: 'tv', title: `Show — S1E${i + 1}` }))
  assert.equal(webhooks.emitManualWatched(store, 'hidden', items), 0)
  assert.equal(webhooks.emitManualWatched(store, 'u1', items), 25)
  await webhooks.whenIdle()
  assert.equal(rx.hits.length, 25)
  assert.equal(JSON.parse(rx.hits[0].raw).data.source, 'manual')
})
