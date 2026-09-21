// <name>.home.beebo.tv: the PC keeps its direct address pointed at the house
// (electron/homeAddress.js), and certs.js gets its Let's Encrypt DNS-01 record
// set through the beebo.tv Worker instead of DuckDNS. No network, no real timers.
// Run: node --test test/home-address.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const appRoot = path.resolve(__dirname, '..')
const ha = require(path.join(appRoot, 'electron', 'homeAddress.js'))
const certs = require(path.join(appRoot, 'electron', 'certs.js'))

function fakeFetch(replies) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), method: init.method })
    const next = typeof replies === 'function' ? replies(url, JSON.parse(init.body), calls.length) : replies.shift()
    if (next instanceof Error) throw next
    return { status: next.status || 200, json: async () => next.body }
  }
  fn.calls = calls
  return fn
}

function fakeTimers() {
  const timers = []
  return {
    timers,
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout', cleared: false }; timers.push(t); return t },
    clearTimeout: (t) => { if (t) t.cleared = true },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval', cleared: false }; timers.push(t); return t },
    clearInterval: (t) => { if (t) t.cleared = true },
  }
}

// ---- homeAddress.js ----------------------------------------------------------

test('updates at start and every 5 minutes, posting the licence token to <name>.beebo.tv', async () => {
  const T = fakeTimers()
  const fetchImpl = fakeFetch(() => ({ body: { ok: true, hostname: 'nick.home.beebo.tv', ip: '81.2.69.160', ipv4: '81.2.69.160', ipv6: null, changed: true } }))
  const logs = []
  const h = ha.createHomeAddress({ getName: () => 'nick', getToken: () => 'TOKEN', fetchImpl, log: (m) => logs.push(m), ...T })
  h.start()
  const first = T.timers.find((t) => t.kind === 'timeout')
  const loop = T.timers.find((t) => t.kind === 'interval')
  assert.ok(first && first.ms <= 30000, 'a first check soon after start')
  assert.equal(loop.ms, 5 * 60 * 1000)
  assert.equal(ha.INTERVAL_MS, 5 * 60 * 1000)

  await first.fn()
  await new Promise((r) => setImmediate(r))
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, 'https://nick.beebo.tv/rtc/home-address')
  assert.deepEqual(fetchImpl.calls[0].body, { token: 'TOKEN', name: 'nick' })
  let st = h.status()
  assert.equal(st.state, 'ok')
  assert.equal(st.hostname, 'nick.home.beebo.tv')
  assert.equal(st.goodHostname, 'nick.home.beebo.tv')
  assert.equal(st.ipv4, '81.2.69.160')
  assert.equal(st.running, true)

  // The interval runs it again; an unchanged result is not logged twice.
  const r = await h.runOnce()
  assert.equal(r.ok, true)
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(logs.length, 1)

  h.stop()
  assert.equal(loop.cleared, true)
  // Stopping before the first check fires cancels that too.
  h.start()
  h.stop()
  assert.ok(T.timers.slice(2).every((t) => t.cleared))
  assert.equal(h.status().running, false)
})

test('waits quietly while signed out or before the name registers', async () => {
  let name = ''
  let token = null
  const fetchImpl = fakeFetch(() => ({ body: { ok: true, hostname: 'nick.home.beebo.tv', ip: '81.2.69.160' } }))
  const h = ha.createHomeAddress({ getName: () => name, getToken: () => token, fetchImpl })
  let r = await h.runOnce()
  assert.equal(r.skipped, true)
  assert.equal(h.status().state, 'waiting')
  assert.equal(h.status().reason, 'not signed in')
  token = 'T'
  r = await h.runOnce()
  assert.equal(h.status().reason, 'no beebo.tv address yet')
  assert.equal(fetchImpl.calls.length, 0)
  name = 'nick'
  assert.equal((await h.runOnce()).ok, true)
  // Agent restarting (name briefly gone): the last good result stays on screen.
  name = ''
  await h.runOnce()
  assert.equal(h.status().state, 'ok')
  // Signing out forgets it, so the certificate default no longer points there.
  token = null
  await h.runOnce()
  assert.equal(h.status().state, 'waiting')
  assert.equal(h.status().goodHostname, '')
})

test('a refusal or a network failure becomes a readable reason, never a throw', async () => {
  const replies = [
    { status: 503, body: { ok: false, error: 'home_address_not_configured' } },
    new Error('getaddrinfo ENOTFOUND nick.beebo.tv'),
    { status: 403, body: { ok: false, error: 'not_your_beebo' } },
  ]
  const h = ha.createHomeAddress({ getName: () => 'nick', getToken: () => 'T', fetchImpl: fakeFetch(replies), log: () => {} })
  let r = await h.runOnce()
  assert.equal(r.ok, false)
  assert.equal(h.status().state, 'error')
  assert.equal(h.status().error, 'home_address_not_configured')
  assert.match(h.status().reason, /isn’t handing out direct addresses/)
  r = await h.runOnce()
  assert.equal(h.status().error, 'network')
  r = await h.runOnce()
  assert.match(h.status().reason, /different Beebo account/)
  assert.equal(h.status().goodHostname, '', 'never confirmed, so no certificate default')
})

test('sends the router external IPv4 only when it is public', async () => {
  let routerIp = '192.168.1.1'
  const fetchImpl = fakeFetch(() => ({ body: { ok: true, hostname: 'nick.home.beebo.tv' } }))
  const h = ha.createHomeAddress({ getName: () => 'nick', getToken: () => 'T', getPublicIp: () => routerIp, fetchImpl })
  await h.runOnce()
  assert.equal(fetchImpl.calls[0].body.ip, undefined)
  routerIp = '100.72.1.9' // carrier-grade NAT
  await h.runOnce()
  assert.equal(fetchImpl.calls[1].body.ip, undefined)
  routerIp = '81.2.69.160'
  await h.runOnce()
  assert.equal(fetchImpl.calls[2].body.ip, '81.2.69.160')
})

test('kick() checks right away unless a check just succeeded', async () => {
  let t = 1_700_000_000_000
  const fetchImpl = fakeFetch(() => ({ body: { ok: true, hostname: 'nick.home.beebo.tv' } }))
  const h = ha.createHomeAddress({ getName: () => 'nick', getToken: () => 'T', fetchImpl, now: () => t })
  await h.kick()
  assert.equal(fetchImpl.calls.length, 1)
  t += 10 * 1000
  await h.kick()
  assert.equal(fetchImpl.calls.length, 1)
  t += 5 * 60 * 1000
  await h.kick()
  assert.equal(fetchImpl.calls.length, 2)
})

test('a request that never answers times out', async () => {
  const hang = () => new Promise(() => {})
  const r = await ha.postWorker({ name: 'nick', path: '/rtc/home-address', body: {}, fetchImpl: hang, timeoutMs: 20 })
  assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'timeout' })
})

test('main.js wires it: started, kicked on register, shown in Settings, used as the certificate default', () => {
  const src = fs.readFileSync(path.join(appRoot, 'electron', 'main.js'), 'utf8')
  assert.match(src, /createHomeAddress\(/)
  assert.match(src, /homeAddress\.start\(\)/)
  assert.match(src, /homeAddress\.kick\(\)/)
  assert.match(src, /homeAddress: safeHomeAddressStatus\(\)/)
  assert.match(src, /licenceToken: getLicenceTokenSafe\(\)/)
  // DuckDNS still wins when it is set up; the home address is the fallback.
  const fn = /function getCertDomain\(\) \{[\s\S]*?\n\}/.exec(src)[0]
  assert.ok(fn.indexOf('detectDuckdnsDomain()') < fn.indexOf('goodHostname'))
  const ui = fs.readFileSync(path.join(appRoot, 'src', 'components', 'BeeboAddress.jsx'), 'utf8')
  assert.match(ui, /Direct address: \$\{h\.hostname\} — up to date/)
  assert.match(ui, /couldn’t update: /)
})

// ---- certs.js: the beebo.tv DNS-01 path ----------------------------------------

// A throwaway self-signed certificate for nick.home.beebo.tv (test fixture only).
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIBsTCCAVagAwIBAgIUVlzESGyuSbXnua5qYPz7c2ALSCswCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSbmljay5ob21lLmJlZWJvLnR2MCAXDTI2MDkxNzA2MTk1OVoY
DzIxMjYwODI0MDYxOTU5WjAdMRswGQYDVQQDDBJuaWNrLmhvbWUuYmVlYm8udHYw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASWfATJiRhiHzIOCcWfm39rwYO5vwXP
f+zAcqs72lsPD5C8fRU0KCkqZnnZA+1VNaewuMb3ErgKCBvsljMpcPDRo3IwcDAd
BgNVHQ4EFgQUUhkCqOVqHXpz2lMCpswCtGvO/XEwHwYDVR0jBBgwFoAUUhkCqOVq
HXpz2lMCpswCtGvO/XEwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHREEFjAUghJuaWNr
LmhvbWUuYmVlYm8udHYwCgYIKoZIzj0EAwIDSQAwRgIhAI8aREWDlExeSPQHdw5b
Sr7hPWxz5etJJHPHz2RgkG91AiEAqEFKto8Zhz4M3bh3JUrH+xEAladm4XPfAwfu
NAFYvR0=
-----END CERTIFICATE-----
`
const keyPem = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' })

// Just enough of acme-client: auto() runs the dns-01 hooks the way the real one does.
function fakeAcme({ keyAuthorization = 'AbC-123_xyz', onAuto } = {}) {
  const seen = { orders: 0 }
  return {
    seen,
    directory: { letsencrypt: { staging: 'staging-url', production: 'production-url' } },
    crypto: {
      createPrivateKey: async () => Buffer.from(keyPem()),
      createCsr: async ({ commonName }) => { seen.commonName = commonName; return [Buffer.from(keyPem()), Buffer.from('csr')] },
    },
    Client: class {
      constructor(o) { seen.directoryUrl = o.directoryUrl }
      async auto(o) {
        seen.orders++
        seen.priority = o.challengePriority
        if (onAuto) return onAuto(o)
        const authz = { identifier: { value: seen.commonName } }
        const challenge = { type: 'dns-01' }
        await o.challengeCreateFn(authz, challenge, keyAuthorization)
        await o.challengeRemoveFn(authz, challenge, keyAuthorization)
        return Buffer.from(FIXTURE_CERT)
      }
    },
  }
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-certs-'))

test('certProvider tells the two apart', () => {
  assert.equal(certs.certProvider('nick.home.beebo.tv'), 'beebo')
  assert.equal(certs.certProvider('NICK.home.beebo.tv.'), 'beebo')
  assert.equal(certs.certProvider('example-house.duckdns.org'), 'duckdns')
  assert.equal(certs.certProvider('example-house'), 'duckdns', 'a bare name still means DuckDNS, as before')
  assert.equal(certs.certProvider('a.b.home.beebo.tv'), '')
  assert.equal(certs.certProvider('nick.beebo.tv'), '')
  assert.equal(certs.certProvider('example.com'), '')
  assert.equal(certs.beeboHomeName('nick.home.beebo.tv'), 'nick')
})

test('home.beebo.tv: TXT set through the Worker, waited for, then cleared; certificate saved', async () => {
  const dir = tmpDir()
  const posts = []
  const acme = fakeAcme({ keyAuthorization: 'AbC-123_xyz' })
  let published = []
  const r = await certs.ensureCertificate({
    domain: 'nick.home.beebo.tv',
    certDir: dir,
    licenceToken: 'LICENCE',
    acme,
    beeboPost: async (url, body) => {
      posts.push({ url, body })
      if (url.endsWith('/acme')) published = [body.value]
      if (url.endsWith('/acme/clear')) published = []
      return { ok: true }
    },
    httpGet: async () => { throw new Error('DuckDNS must not be called') },
    resolveTxt: async (name) => { assert.equal(name, '_acme-challenge.nick.home.beebo.tv'); return published.map((v) => [v]) },
    propagationDelayMs: 0,
    fallbackSleepMs: 0,
  })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.reason, 'new certificate obtained')
  assert.equal(acme.seen.commonName, 'nick.home.beebo.tv')
  assert.deepEqual(acme.seen.priority, ['dns-01'])
  assert.equal(acme.seen.directoryUrl, 'production-url')
  assert.deepEqual(posts.map((p) => p.url), [
    'https://nick.beebo.tv/rtc/home-address/acme',
    'https://nick.beebo.tv/rtc/home-address/acme/clear',
  ])
  assert.deepEqual(posts[0].body, { token: 'LICENCE', name: 'nick', value: 'AbC-123_xyz' })
  assert.deepEqual(posts[1].body, { token: 'LICENCE', name: 'nick' })
  assert.ok(fs.existsSync(path.join(dir, 'cert.pem')) && fs.existsSync(path.join(dir, 'key.pem')))
  assert.equal(certs.certificateStatus(dir).domain, 'nick.home.beebo.tv')

  // The next run finds it valid and does nothing at all.
  const again = await certs.ensureCertificate({ domain: 'nick.home.beebo.tv', certDir: dir, licenceToken: 'LICENCE', acme, beeboPost: async () => { throw new Error('no') } })
  assert.equal(again.ok, true)
  assert.equal(again.reason, 'existing certificate is still valid')
  assert.equal(acme.seen.orders, 1)
})

test('home.beebo.tv: a Worker refusal is a plain reason, and the record is still cleared', async () => {
  const posts = []
  const r = await certs.ensureCertificate({
    domain: 'nick.home.beebo.tv',
    certDir: tmpDir(),
    licenceToken: 'LICENCE',
    acme: fakeAcme(),
    beeboPost: async (url) => { posts.push(url); return url.endsWith('/acme') ? { ok: false, error: 'home_address_not_configured' } : { ok: true } },
    propagationDelayMs: 0,
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /home addresses aren't switched on/)
  assert.ok(posts.some((u) => u.endsWith('/acme/clear')), 'clean-up attempted')
})

test('home.beebo.tv without a Beebo sign-in asks to sign in, and never needs a DuckDNS token', async () => {
  const acme = fakeAcme()
  const r = await certs.ensureCertificate({ domain: 'nick.home.beebo.tv', certDir: tmpDir(), acme, token: '' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /sign in to Beebo/)
  assert.equal(acme.seen.orders, 0)
})

test('DuckDNS still works exactly as before', async () => {
  const urls = []
  let txt = ''
  const acme = fakeAcme({ keyAuthorization: 'duckvalue' })
  const r = await certs.ensureCertificate({
    domain: 'example-house.duckdns.org',
    token: 'DUCKTOKEN',
    certDir: tmpDir(),
    acme,
    httpGet: async (url) => { urls.push(url); const m = /txt=([^&]*)/.exec(url); txt = m ? decodeURIComponent(m[1]) : ''; return 'OK' },
    beeboPost: async () => { throw new Error('the Worker must not be called for DuckDNS') },
    resolveTxt: async () => [[txt]],
    propagationDelayMs: 0,
  })
  // The fixture certificate is for a different name; ensureCertificate only
  // checks names when deciding whether to renew, so this still succeeds.
  assert.equal(r.ok, true, r.reason)
  assert.match(urls[0], /^https:\/\/www\.duckdns\.org\/update\?domains=example-house&token=DUCKTOKEN&txt=duckvalue$/)
  assert.match(urls[1], /clear=true/)
  const noToken = await certs.ensureCertificate({ domain: 'example-house.duckdns.org', certDir: tmpDir(), acme: fakeAcme() })
  assert.match(noToken.reason, /no DuckDNS token/)
})

test('other domains are refused with a reason that names both options', async () => {
  const r = await certs.ensureCertificate({ domain: 'example.com', certDir: tmpDir(), acme: fakeAcme() })
  assert.equal(r.ok, false)
  assert.match(r.reason, /duckdns\.org and <name>\.home\.beebo\.tv/)
})
