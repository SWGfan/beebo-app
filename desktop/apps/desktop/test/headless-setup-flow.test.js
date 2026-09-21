// Headless server: first-run owner setup. It must be usable only until the first
// owner exists, must need the printed one-time code, must be rate limited, and
// must switch itself off afterwards.
// Run: node --test test/headless-setup-flow.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))
const { createSetupFlow, SETUP_API, SETUP_PAGE } = require(path.join(__dirname, '..', 'headless', 'setupFlow.js'))

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return {
    data,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v },
    has: (k) => k in data,
    delete: (k) => { delete data[k] }
  }
}

function makeFlow(opts = {}) {
  const store = opts.store || fakeStore()
  const printed = []
  let now = 1_700_000_000_000
  const flow = createSetupFlow({
    store,
    auth,
    print: (line) => printed.push(line),
    now: () => now,
    getUrls: () => ['https://192.168.1.20:47811'],
    limits: opts.limits
  })
  return { flow, store, printed, advance: (ms) => { now += ms }, code: () => flow._codeForTests() }
}

const GOOD = { username: 'nick', password: 'a long password' }

test('nothing is exposed until the code is generated and printed; the log carries the URL and the code', () => {
  const { flow, printed, code } = makeFlow()
  assert.equal(code(), null)
  flow.announce()
  const text = printed.join('\n')
  assert.match(text, /https:\/\/192\.168\.1\.20:47811\/setup/)
  assert.match(text, /Setup code: [2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}/)
  assert.ok(text.includes(code()))
})

test('the code is random per instance and has 60 bits of entropy', () => {
  const codes = new Set()
  for (let i = 0; i < 50; i++) {
    const { flow, code } = makeFlow()
    flow.announce()
    assert.match(code(), /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/)
    codes.add(code())
  }
  assert.equal(codes.size, 50)
})

test('without the right code no owner is created', () => {
  const { flow, store } = makeFlow()
  flow.announce()
  for (const bad of [undefined, null, '', 'AAAA-BBBB-CCCC', 123, {}, []]) {
    const r = flow.attempt({ code: bad, ...GOOD, ip: '1.1.1.1' })
    assert.ok([403, 429].includes(r.status), String(bad))
  }
  assert.equal(auth.hasOwner(store), false)
})

test('the right code creates exactly one approved admin and the code is then dead', () => {
  const { flow, store, code } = makeFlow()
  flow.announce()
  const c = code()
  const r = flow.attempt({ code: c, ...GOOD, ip: '1.1.1.1' })
  assert.equal(r.status, 200)
  assert.equal(auth.hasOwner(store), true)
  const users = auth.getUsers(store)
  assert.equal(users.length, 1)
  assert.equal(users[0].isAdmin, true)
  assert.equal(users[0].status, 'approved')
  assert.equal(code(), null)
  const again = flow.attempt({ code: c, username: 'mallory', password: 'another password', ip: '6.6.6.6' })
  assert.equal(again.status, 404)
  assert.equal(auth.getUsers(store).length, 1)
  assert.equal(flow.needsSetup(), false)
})

test('the code is case and dash insensitive but nothing else', () => {
  const { flow, code } = makeFlow()
  flow.announce()
  const sloppy = code().toLowerCase().replace(/-/g, ' ')
  assert.equal(flow.attempt({ code: sloppy, ...GOOD, ip: 'a' }).status, 200)
})

test('a correct code with a weak or malformed account does not consume the code', () => {
  const { flow, store, code } = makeFlow()
  flow.announce()
  const c = code()
  assert.equal(flow.attempt({ code: c, username: 'nick', password: 'short', ip: 'a' }).status, 400)
  assert.equal(flow.attempt({ code: c, username: 'nick', password: 12345678, ip: 'a' }).status, 400)
  assert.equal(flow.attempt({ code: c, username: 'x', password: 'long enough pw', ip: 'a' }).status, 400)
  assert.equal(auth.hasOwner(store), false)
  assert.equal(code(), c)
  assert.equal(flow.attempt({ code: c, ...GOOD, ip: 'a' }).status, 200)
})

test('five wrong codes lock setup, rotate the code and print the new one', () => {
  const { flow, printed, code, advance, store } = makeFlow()
  flow.announce()
  const first = code()
  for (let i = 0; i < 4; i++) assert.equal(flow.attempt({ code: 'WRONG-WRONG-XXXX', ...GOOD, ip: 'ip' + i }).status, 403)
  assert.equal(flow.attempt({ code: 'WRONG-WRONG-XXXX', ...GOOD, ip: 'ip5' }).status, 429)
  assert.notEqual(code(), first)
  assert.match(printed.join('\n'), /Too many wrong setup codes/)
  assert.ok(printed.join('\n').includes(code()))
  const locked = flow.attempt({ code: code(), ...GOOD, ip: 'other' })
  assert.equal(locked.status, 429)
  assert.ok(locked.retryAfter > 0)
  assert.equal(auth.hasOwner(store), false)
  advance(10 * 60 * 1000 + 1000)
  assert.equal(flow.attempt({ code: first, ...GOOD, ip: 'other' }).status, 403)
  assert.equal(flow.attempt({ code: code(), ...GOOD, ip: 'other' }).status, 200)
})

test('one address is limited to 8 attempts a minute, then allowed again', () => {
  const { flow, advance } = makeFlow({ limits: { maxCodeFailures: 1000 } })
  flow.announce()
  for (let i = 0; i < 8; i++) assert.equal(flow.attempt({ code: 'AAAA-AAAA-AAAA', ...GOOD, ip: '9.9.9.9' }).status, 403)
  const blocked = flow.attempt({ code: 'AAAA-AAAA-AAAA', ...GOOD, ip: '9.9.9.9' })
  assert.equal(blocked.status, 429)
  assert.equal(flow.attempt({ code: 'AAAA-AAAA-AAAA', ...GOOD, ip: '8.8.8.8' }).status, 403)
  advance(61 * 1000)
  assert.equal(flow.attempt({ code: 'AAAA-AAAA-AAAA', ...GOOD, ip: '9.9.9.9' }).status, 403)
})

test('a server that already has an owner never offers setup and never prints a code', () => {
  const store = fakeStore()
  auth.createOwner(store, { username: 'existing', password: 'existing password' })
  const { flow, printed } = makeFlow({ store })
  flow.announce()
  assert.deepEqual(printed, [])
  assert.equal(flow.needsSetup(), false)
  assert.equal(flow.attempt({ code: 'AAAA-AAAA-AAAA', ...GOOD }).status, 404)
})

test('an owner made by other means (desktop, restore) closes setup on the next request', () => {
  const { flow, store, code } = makeFlow()
  flow.announce()
  const c = code()
  auth.createOwner(store, { username: 'desktop', password: 'desktop password' })
  assert.equal(flow.attempt({ code: c, ...GOOD, ip: 'a' }).status, 404)
  assert.equal(auth.getUsers(store).length, 1)
})

async function withServer(t, flow) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (flow.hook(req, res, url)) return
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('normal server 404')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  return (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body))
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    r.on('error', reject)
    if (data !== null) r.write(data)
    r.end()
  })
}

test('HTTP: setup page and API work while there is no owner, and disappear afterwards', async (t) => {
  const { flow, code, store } = makeFlow()
  flow.announce()
  const call = await withServer(t, flow)

  const page = await call('GET', SETUP_PAGE)
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.match(page.text, /Set up Beebo/)

  const root = await call('GET', '/', undefined, { Accept: 'text/html' })
  assert.equal(root.status, 302)
  assert.equal(root.headers.location, '/setup')
  const api = await call('GET', '/', undefined, { Accept: 'application/json' })
  assert.equal(api.status, 404)

  const wrong = await call('POST', SETUP_API, { code: 'AAAA-AAAA-AAAA', ...GOOD })
  assert.equal(wrong.status, 403)
  const ok = await call('POST', SETUP_API, { code: code(), ...GOOD })
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.text), { ok: true })
  assert.equal(auth.hasOwner(store), true)

  for (const p of [SETUP_PAGE, SETUP_API]) {
    const after = await call(p === SETUP_API ? 'POST' : 'GET', p, p === SETUP_API ? { code: 'x', ...GOOD } : undefined)
    assert.equal(after.status, 404, p)
    assert.equal(after.text, 'normal server 404')
  }
  const rootAfter = await call('GET', '/', undefined, { Accept: 'text/html' })
  assert.equal(rootAfter.status, 404)
})

test('HTTP: only JSON POSTs from the same origin are accepted, bodies are capped', async (t) => {
  const { flow, code, store } = makeFlow()
  flow.announce()
  const call = await withServer(t, flow)
  const good = JSON.stringify({ code: code(), ...GOOD })
  const form = await call('POST', SETUP_API, good, { 'Content-Type': 'application/x-www-form-urlencoded' })
  assert.equal(form.status, 403)
  const cross = await call('POST', SETUP_API, good, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })
  assert.equal(cross.status, 403)
  const get = await call('GET', SETUP_API)
  assert.equal(get.status, 405)
  const badJson = await call('POST', SETUP_API, '{nope')
  assert.equal(badJson.status, 400)
  const huge = await call('POST', SETUP_API, JSON.stringify({ code: 'x'.repeat(10_000), ...GOOD }))
  assert.equal(huge.status, 413)
  assert.equal(auth.hasOwner(store), false)
})

test('HTTP: the password is never echoed or logged', async (t) => {
  const { flow, code, printed } = makeFlow()
  flow.announce()
  const call = await withServer(t, flow)
  const r = await call('POST', SETUP_API, { code: code(), username: 'nick', password: 'super secret pw 123' })
  assert.equal(r.status, 200)
  assert.equal(r.text.includes('super secret pw'), false)
  assert.equal(printed.join('\n').includes('super secret pw'), false)
})
