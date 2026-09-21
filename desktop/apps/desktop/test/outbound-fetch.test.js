// The SSRF-guarded client that podcasts and radio use for everything they fetch: private and
// metadata addresses, redirect re-checks, pinned connections, byte and time limits, unpacking.
// Only 127.0.0.1 servers made here; nothing touches the internet.
// Run: node --test test/outbound-fetch.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const zlib = require('node:zlib')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { createFetcher, FetchError } = localRequire('./electron/outboundFetch')
const webhooks = localRequire('./electron/webhooks')

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, url: (p = '/') => `http://127.0.0.1:${server.address().port}${p}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }) }))
  })
}
const rejectsWith = async (p, code) => {
  await assert.rejects(p, (e) => { assert.ok(e instanceof FetchError, String(e)); assert.equal(e.code, code, e.message); return true })
}

test('the local network and metadata addresses are refused; the owner can allow only the local network', async () => {
  const s = await serve((req, res) => { res.end('hello') })
  try {
    const strict = createFetcher({ allowPrivateNetwork: false })
    await rejectsWith(strict.get(s.url()), 'blocked_private')
    await rejectsWith(strict.get('http://10.1.2.3/x'), 'blocked_private')
    await rejectsWith(strict.get('http://192.168.1.1/x'), 'blocked_private')
    await rejectsWith(strict.get('http://[::1]/x'), 'blocked_private')
    await rejectsWith(strict.get('http://100.64.0.1/x'), 'blocked_private')
    const open = createFetcher({ allowPrivateNetwork: () => true })
    assert.equal((await open.get(s.url())).body.toString(), 'hello')
    // never allowed, whatever the owner ticked: link-local (cloud metadata), "this network", multicast, mapped/NAT64/6to4 forms
    for (const bad of ['http://169.254.169.254/latest/meta-data/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://[::ffff:169.254.169.254]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:a9fe:a9fe::1]/', 'http://[fe80::1]/', 'http://[::]/']) {
      await rejectsWith(open.get(bad), 'blocked_address')
    }
    // an IPv4 address written in the odd ways URLs allow is still that address
    await rejectsWith(open.get('http://2852039166/'), 'blocked_address') // 169.254.169.254 as one integer
    await rejectsWith(open.get('http://0xa9fea9fe/'), 'blocked_address')
    await rejectsWith(open.get('http://169.254.169.254.:80/'), 'blocked_address')
  } finally { await s.close() }
})

test('fixed-host services (allowHosts): https, port 443 and the listed host only, on every hop', async () => {
  const s = await serve((req, res) => { res.writeHead(302, { Location: 'https://elsewhere.example.test/x' }); res.end() })
  try {
    const f = createFetcher({ allowPrivateNetwork: true })
    await rejectsWith(f.get(s.url('/x'), { allowHosts: ['itunes.apple.com'] }), 'blocked_url')
    await rejectsWith(f.get('http://itunes.apple.com/search', { allowHosts: ['itunes.apple.com'] }), 'blocked_url')
    await rejectsWith(f.get('https://itunes.apple.com:8443/search', { allowHosts: ['itunes.apple.com'] }), 'blocked_url')
    await rejectsWith(f.get('https://evil.test/search', { allowHosts: ['itunes.apple.com', '.api.radio-browser.info'] }), 'blocked_url')
    await rejectsWith(f.get('https://itunes.apple.com.evil.test/', { allowHosts: ['itunes.apple.com'] }), 'blocked_url')
    // a subdomain entry written with a leading dot
    await rejectsWith(f.get('https://api.radio-browser.info.evil.test/', { allowHosts: ['.api.radio-browser.info'] }), 'blocked_url')
  } finally { await s.close() }
})

test('only http(s), no credentials in the address, no junk', async () => {
  const f = createFetcher({ allowPrivateNetwork: true })
  for (const bad of ['file:///etc/passwd', 'ftp://example.test/x', 'gopher://example.test/', 'javascript:alert(1)', 'http://user:pw@example.test/', '', 'not a url', 'http://']) {
    await rejectsWith(f.get(bad), 'bad_url')
  }
})

test('a redirect is judged again at every hop: public page cannot bounce the request to metadata or a bad scheme', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/to-metadata') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return }
    if (req.url === '/to-file') { res.writeHead(302, { Location: 'file:///etc/passwd' }); res.end(); return }
    if (req.url === '/to-lan') { res.writeHead(301, { Location: 'http://192.168.0.10/admin' }); res.end(); return }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return }
    if (req.url === '/relative') { res.writeHead(307, { Location: '/final' }); res.end(); return }
    if (req.url === '/final') { res.end('arrived') }
  })
  try {
    // the first hop (127.0.0.1) is allowed here; what matters is what it points at
    const f = createFetcher({ allowPrivateNetwork: () => true })
    await rejectsWith(f.get(s.url('/to-metadata')), 'blocked_address')
    await rejectsWith(f.get(s.url('/to-file')), 'bad_url')
    await rejectsWith(f.get(s.url('/loop')), 'too_many_redirects')
    assert.equal((await f.get(s.url('/relative'))).body.toString(), 'arrived')
    // and with the local network refused, the LAN redirect fails at the very first hop
    const strict = createFetcher({ allowPrivateNetwork: false })
    await rejectsWith(strict.get(s.url('/to-lan')), 'blocked_private')
    // LAN allowed: the 192.168 hop is judged 'lan' and permitted by policy (it just cannot connect here)
    const lan = createFetcher({ allowPrivateNetwork: true, resolve: async (u, o) => { const t = await webhooks.resolveTarget(u, o); if (t.ok && t.url.hostname === '192.168.0.10') throw new FetchError('reached_lan_hop'); return t } })
    await rejectsWith(lan.get(s.url('/to-lan')), 'reached_lan_hop')
  } finally { await s.close() }
})

test('the connection goes to the address that was judged (no second lookup to rebind to)', async () => {
  const s = await serve((req, res) => { res.end('pinned:' + req.headers.host) })
  try {
    // "rebind.test" does not resolve anywhere; the fetcher must use the address its resolver returned.
    const f = createFetcher({ resolve: async (raw) => ({ ok: true, url: new URL(raw), addresses: [{ address: '127.0.0.1', family: 4 }] }) })
    const r = await f.get(`http://rebind.test:${s.port}/x`)
    assert.equal(r.body.toString(), `pinned:rebind.test:${s.port}`)
  } finally { await s.close() }
})

test('size limits: declared, streamed, and unpacked (a small gzip that expands is stopped)', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61))
  const s = await serve((req, res) => {
    if (req.url === '/declared') { res.writeHead(200, { 'Content-Length': '999999999' }); res.end('x'); return }
    if (req.url === '/streamed') { res.writeHead(200); const t = setInterval(() => res.write(Buffer.alloc(64 * 1024, 1)), 1); res.on('close', () => clearInterval(t)); return }
    if (req.url === '/bomb') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(bomb); return }
    if (req.url === '/gzip') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync('gzipped ok')); return }
    if (req.url === '/br') { res.writeHead(200, { 'Content-Encoding': 'br' }); res.end(zlib.brotliCompressSync('brotli ok')); return }
    if (req.url === '/weird') { res.writeHead(200, { 'Content-Encoding': 'compress' }); res.end('x'); return }
  })
  try {
    const f = createFetcher({ allowPrivateNetwork: true })
    await rejectsWith(f.get(s.url('/declared'), { maxBytes: 1024 }), 'too_large')
    await rejectsWith(f.get(s.url('/streamed'), { maxBytes: 200 * 1024 }), 'too_large')
    assert.ok(bomb.length < 100 * 1024, 'the bomb is small on the wire')
    await rejectsWith(f.get(s.url('/bomb'), { maxBytes: 1024 * 1024 }), 'too_large')
    assert.equal((await f.get(s.url('/gzip'))).body.toString(), 'gzipped ok')
    assert.equal((await f.get(s.url('/br'))).body.toString(), 'brotli ok')
    await rejectsWith(f.get(s.url('/weird')), 'unsupported_encoding')
  } finally { await s.close() }
})

test('time limits: a server that never answers, and one that stalls mid-body', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/silent') return
    res.writeHead(200)
    res.write('start')
  })
  try {
    const f = createFetcher({ allowPrivateNetwork: true })
    const t0 = Date.now()
    await rejectsWith(f.get(s.url('/silent'), { timeoutMs: 300 }), 'timeout')
    await rejectsWith(f.get(s.url('/stall'), { timeoutMs: 300 }), 'timeout')
    assert.ok(Date.now() - t0 < 3000)
  } finally { await s.close() }
})

test('conditional requests pass through; 304 has no body; headers are readable', async () => {
  const seen = []
  const s = await serve((req, res) => {
    seen.push({ inm: req.headers['if-none-match'], ims: req.headers['if-modified-since'], ua: req.headers['user-agent'] })
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); res.end(); return }
    res.writeHead(200, { ETag: '"v1"', 'Last-Modified': 'Wed, 10 Jan 2024 08:00:00 GMT' })
    res.end('body')
  })
  try {
    const f = createFetcher({ allowPrivateNetwork: true })
    const a = await f.get(s.url())
    assert.equal(a.status, 200)
    assert.equal(a.headers.etag, '"v1"')
    const b = await f.get(s.url(), { headers: { 'If-None-Match': a.headers.etag } })
    assert.equal(b.status, 304)
    assert.equal(b.body.length, 0)
    assert.match(seen[0].ua, /^BeeboEntertainment\/[\d.]+ /, 'a proper User-Agent, as radio-browser.info asks')
  } finally { await s.close() }
})

test('download: to a file via .part, size cap, wrong type refused, non-200 refused, no leftovers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-dl-'))
  const s = await serve((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.alloc(5000, 7)); return }
    if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>pay up</html>'); return }
    if (req.url === '/404') { res.writeHead(404); res.end('nope'); return }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); const t = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 1); res.on('close', () => clearInterval(t)); return }
  })
  try {
    const f = createFetcher({ allowPrivateNetwork: true })
    const accept = (h) => /^audio\//.test(h['content-type'] || '')
    const out = path.join(dir, 'a', 'ok.mp3')
    const r = await f.download(s.url('/ok'), out, { accept })
    assert.equal(r.size, 5000)
    assert.equal(fs.statSync(out).size, 5000)
    await rejectsWith(f.download(s.url('/html'), path.join(dir, 'h.mp3'), { accept }), 'wrong_type')
    await rejectsWith(f.download(s.url('/404'), path.join(dir, 'n.mp3'), { accept }), 'http_status')
    await rejectsWith(f.download(s.url('/big'), path.join(dir, 'b.mp3'), { accept, maxBytes: 256 * 1024 }), 'too_large')
    await rejectsWith(f.download('http://169.254.169.254/x', path.join(dir, 'm.mp3'), { accept }), 'blocked_address')
    const left = fs.readdirSync(dir).filter((n) => n !== 'a')
    assert.deepEqual(left, [], 'no .part or partial file is left behind')
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('open(): a live stream comes back unread, with the final address and a close()', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { Location: '/live' }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-name': 'Test FM' })
    res.write('abc')
  })
  try {
    const f = createFetcher({ allowPrivateNetwork: true })
    const r = await f.open(s.url('/hop'))
    assert.equal(r.status, 200)
    assert.equal(r.headers['icy-name'], 'Test FM')
    assert.match(r.url, /\/live$/)
    const first = await new Promise((resolve) => r.stream.once('data', resolve))
    assert.equal(first.toString(), 'abc')
    r.close()
  } finally { await s.close() }
})
