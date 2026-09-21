// Security review F8 (path edges: poster ids, Windows device names) and F10 (third-party download
// links: https only, host allowlist, size cap, timeout, content type).
// Run: node --test test/path-and-fetch-safety.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { withServer, localRequire } = require('./security-harness')
const safePath = localRequire('./electron/safePath')
const safeFetch = localRequire('./electron/safeFetch')
const tmdbCache = localRequire('./electron/tmdbCache')

// ------------------------------------------------------------------ F8 ----

test('safePath: traversal, device names, trailing dots and spaces, illegal characters', () => {
  const table = [
    ['a/b/c.mp4', 'a/b/c.mp4'],
    ['a\\b\\c.mp4', 'a/b/c.mp4'],
    ['../../etc/passwd', 'etc/passwd'],
    ['a/../b', 'a/b'],
    ['./a//b/', 'a/b'],
    ['CON', '_CON'], ['con', '_con'], ['PRN', '_PRN'], ['AUX', '_AUX'], ['NUL', '_NUL'],
    ['COM1', '_COM1'], ['com9', '_com9'], ['LPT1', '_LPT1'], ['lpt9', '_lpt9'],
    ['nul.txt', '_nul.txt'], ['Aux.tar.gz', '_Aux.tar.gz'],
    ['CON.', '_CON'], ['CON ', '_CON'], ['CON . ', '_CON'],
    ['photos/COM3/x.jpg', 'photos/_COM3/x.jpg'],
    ['name.', 'name'], ['name ', 'name'], ['a. /b', 'a/b'],
    ['bad<>:"|?*name.mp4', 'bad_______name.mp4'],
    ['C:\\Windows\\x.dll', 'C_/Windows/x.dll'],
    ['stream.mp4:hidden', 'stream.mp4_hidden'],
    ['console', 'console'], ['com10', 'com10'], ['nullable', 'nullable'], ['lpt', 'lpt']
  ]
  for (const [input, want] of table) assert.equal(safePath.safeRel(input), want, JSON.stringify(input))
  assert.equal(safePath.safeRel(''), '')
  assert.equal(safePath.safeRel(null), '')
  assert.equal(safePath.safeSegment('..'), '')
  assert.equal(safePath.safeSegment('x'.repeat(500)).length, 200)
  assert.ok(safePath.isReservedDeviceName('CoM2.txt'))
  assert.ok(!safePath.isReservedDeviceName('comet'))
  // Whatever goes in, resolving it under a root stays under that root.
  const root = path.resolve(os.tmpdir(), 'beebo-root')
  for (const nasty of ['../../x', '..\\..\\x', '/etc/passwd', 'C:\\x', 'a/../../b', '....//x']) {
    const full = path.resolve(root, safePath.safeRel(nasty))
    assert.ok(full === root || full.startsWith(root + path.sep), nasty)
  }
})

test('image ids: digits and plain names only, never a device name or a separator', () => {
  for (const ok of ['1', '12345', 'abc_DEF-1', 123]) assert.equal(tmdbCache.isSafeImageId(ok), true, String(ok))
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', 'CON', 'nul', 'lpt1', 'a.b', 'a b', 'x'.repeat(41), null, undefined, '12:34']) assert.equal(tmdbCache.isSafeImageId(bad), false, String(bad))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-img-'))
  try {
    const p = tmdbCache.paths(dir)
    tmdbCache.ensureDirs(dir)
    fs.writeFileSync(path.join(p.postersDir, '42.jpg'), 'jpg')
    assert.ok(tmdbCache.localPosterPath(dir, '42'))
    assert.equal(tmdbCache.localPosterPath(dir, '../posters/42'), null)
    assert.equal(tmdbCache.localPosterPath(dir, 'CON'), null)
    assert.equal(tmdbCache.localActorPhotoPath(dir, '..'), null)
    assert.equal(tmdbCache.localTvPosterPath(dir, 'nul'), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('/media/poster|actor|poster-tv only accept /^\\d{1,12}$/ ids', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tmdb-'))
  try {
    const p = tmdbCache.paths(cacheDir)
    tmdbCache.ensureDirs(cacheDir)
    fs.writeFileSync(path.join(p.postersDir, '42.jpg'), 'poster')
    fs.writeFileSync(path.join(p.actorsDir, '7.jpg'), 'actor')
    fs.writeFileSync(path.join(p.tvPostersDir, '9.jpg'), 'tv')
    fs.writeFileSync(path.join(p.postersDir, 'abc.jpg'), 'letters')
    fs.writeFileSync(path.join(cacheDir, 'secret.jpg'), 'secret')
    await withServer({ getTmdbCacheDir: () => cacheDir }, async ({ raw }) => {
      for (const [u, body] of [['/media/poster/42.jpg', 'poster'], ['/media/actor/7.jpg', 'actor'], ['/media/poster-tv/9.jpg', 'tv']]) {
        const r = await raw({ pathname: u })
        assert.equal(r.status, 200, u)
        assert.equal(r.text, body)
      }
      const hostile = ['/media/poster/abc.jpg', '/media/poster/CON.jpg', '/media/poster/nul.jpg', '/media/poster/42', '/media/poster/42.jpg.jpg',
        '/media/poster/1234567890123.jpg', '/media/poster/%2e%2e%2fsecret.jpg', '/media/poster/..%2fsecret.jpg', '/media/poster/..%5csecret.jpg',
        '/media/poster/42.jpg%00', '/media/actor/lpt1.jpg', '/media/poster-tv/aux.jpg', '/media/poster/4%202.jpg', '/media/poster/-1.jpg']
      for (const u of hostile) {
        const r = await raw({ pathname: u })
        assert.equal(r.status, 404, u + ' -> ' + r.status)
        assert.doesNotMatch(r.text, /secret|letters/)
      }
    })
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }) }
})

// ----------------------------------------------------------------- F10 ----

function fakeResponse({ status = 200, headers = {}, body = Buffer.alloc(0), chunks } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  const parts = chunks || [body]
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null) },
    body: { getReader() { let i = 0; return { read: async () => (i < parts.length ? { done: false, value: new Uint8Array(parts[i++]) } : { done: true }), cancel: async () => { i = parts.length } } } },
    arrayBuffer: async () => Buffer.concat(parts).buffer
  }
}

test('safeFetch: only https to allowlisted hosts, checked again on every redirect', async () => {
  const hosts = ['image.tmdb.org', '.opensubtitles.org']
  const seen = []
  const ok = async (url) => { seen.push(url); return fakeResponse({ headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('abc') }) }
  assert.equal((await safeFetch.fetchLimited('https://image.tmdb.org/t/p/w300/a.jpg', { allowHosts: hosts, fetchImpl: ok })).ok, true)
  assert.equal((await safeFetch.fetchLimited('https://dl.opensubtitles.org/x', { allowHosts: hosts, fetchImpl: ok })).ok, true, 'subdomain rule')
  for (const bad of ['http://image.tmdb.org/a.jpg', 'https://evil.example/a.jpg', 'https://image.tmdb.org.evil.example/a.jpg', 'https://opensubtitles.org.evil.example/x',
    'https://user:pw@image.tmdb.org/a', 'https://image.tmdb.org:8443/a', 'file:///etc/passwd', 'ftp://image.tmdb.org/a', 'https://127.0.0.1/a', 'javascript:alert(1)', 'not a url', '']) {
    seen.length = 0
    const r = await safeFetch.fetchLimited(bad, { allowHosts: hosts, fetchImpl: ok })
    assert.equal(r.ok, false, bad)
    assert.equal(r.reason, 'blocked_url', bad)
    assert.equal(seen.length, 0, 'nothing was requested for ' + bad)
  }
  // Redirects: to an allowed host is followed; to anywhere else is refused before it is requested.
  const calls = []
  const redirecting = (target) => async (url) => {
    calls.push(url)
    return calls.length === 1 ? fakeResponse({ status: 302, headers: { location: target } }) : fakeResponse({ headers: { 'content-type': 'text/plain' }, body: Buffer.from('x') })
  }
  let r = await safeFetch.fetchLimited('https://dl.opensubtitles.org/a', { allowHosts: hosts, fetchImpl: redirecting('https://cdn.opensubtitles.org/b') })
  assert.equal(r.ok, true)
  calls.length = 0
  r = await safeFetch.fetchLimited('https://dl.opensubtitles.org/a', { allowHosts: hosts, fetchImpl: redirecting('http://169.254.169.254/latest/meta-data') })
  assert.deepEqual([r.ok, r.reason, calls.length], [false, 'blocked_redirect', 1])
  calls.length = 0
  r = await safeFetch.fetchLimited('https://dl.opensubtitles.org/a', { allowHosts: hosts, fetchImpl: redirecting('https://evil.example/x') })
  assert.equal(r.reason, 'blocked_redirect')
  const loop = async () => fakeResponse({ status: 302, headers: { location: 'https://dl.opensubtitles.org/again' } })
  assert.equal((await safeFetch.fetchLimited('https://dl.opensubtitles.org/a', { allowHosts: hosts, fetchImpl: loop })).reason, 'too_many_redirects')
})

test('safeFetch: size cap (declared and streamed), content type, status, timeout', async () => {
  const hosts = ['image.tmdb.org']
  const u = 'https://image.tmdb.org/a'
  let r = await safeFetch.fetchLimited(u, { allowHosts: hosts, maxBytes: 10, fetchImpl: async () => fakeResponse({ headers: { 'content-length': '11', 'content-type': 'image/png' }, body: Buffer.alloc(11) }) })
  assert.equal(r.reason, 'too_large', 'declared size')
  r = await safeFetch.fetchLimited(u, { allowHosts: hosts, maxBytes: 10, fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/png' }, chunks: [Buffer.alloc(6), Buffer.alloc(6)] }) })
  assert.equal(r.reason, 'too_large', 'a server that omits or lies about Content-Length still stops at the cap')
  r = await safeFetch.fetchLimited(u, { allowHosts: hosts, maxBytes: 10, contentType: /^image\//, fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') }) })
  assert.equal(r.reason, 'bad_content_type')
  r = await safeFetch.fetchLimited(u, { allowHosts: hosts, contentType: /^image\//, fetchImpl: async () => fakeResponse({ body: Buffer.from('x') }) })
  assert.equal(r.reason, 'bad_content_type', 'no content type at all')
  r = await safeFetch.fetchLimited(u, { allowHosts: hosts, fetchImpl: async () => fakeResponse({ status: 404 }) })
  assert.equal(r.reason, 'http_404')
  r = await safeFetch.fetchLimited(u, { allowHosts: hosts, timeoutMs: 30, fetchImpl: (url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))) }) })
  assert.equal(r.reason, 'network', 'a hung server times out')
})

test('OpenSubtitles download link: only its own https hosts, capped, subtitle-like; base_url must be an OpenSubtitles host', async () => {
  const osub = localRequire('./electron/openSubtitles')
  const requested = []
  const make = (link, linkResponse) => osub.createOpenSubtitlesClient({
    config: { apiKey: 'K', username: 'u', password: 'p' },
    fetchImpl: async (url, init = {}) => {
      requested.push(String(url))
      const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), headers: { get: () => 'application/json' } })
      if (String(url).endsWith('/login')) return json({ token: 'T', base_url: 'evil.example' })
      if (String(url).endsWith('/download')) return json({ link, file_name: 'x.srt', remaining: 5 })
      return linkResponse()
    }
  })
  const srt = () => fakeResponse({ headers: { 'content-type': 'application/x-subrip' }, body: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n') })
  let out = await make('https://dl.opensubtitles.org/en/download/x.srt', srt).download(1)
  assert.match(out.data.toString(), /hi/)
  assert.ok(!requested.some((u) => u.includes('evil.example')), 'a foreign base_url from login is ignored')
  for (const bad of ['http://dl.opensubtitles.org/x.srt', 'https://evil.example/x.srt', 'https://dl.opensubtitles.org.evil.example/x', 'file:///c:/secret', 'https://169.254.169.254/x']) {
    requested.length = 0
    await assert.rejects(make(bad, srt).download(1), /trust|not opened/i, bad)
    assert.ok(!requested.some((u) => u === bad), 'the bad link was never requested: ' + bad)
  }
  await assert.rejects(make('https://dl.opensubtitles.org/x', () => fakeResponse({ headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') })).download(1), /not a normal subtitle/i)
  await assert.rejects(make('https://dl.opensubtitles.org/x', () => fakeResponse({ headers: { 'content-type': 'text/plain', 'content-length': String(50 * 1024 * 1024) }, body: Buffer.alloc(1) })).download(1), /not a normal subtitle/i)
})

test('tmdbCache.downloadImage: refuses other hosts, non-images and oversize files; writes a good image', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-dl-'))
  try {
    const dest = (n) => path.join(dir, n)
    const okFetch = async () => fakeResponse({ headers: { 'content-type': 'image/jpeg' }, body: Buffer.from('JPEGDATA') })
    assert.equal(await tmdbCache.downloadImage('https://image.tmdb.org/t/p/w300/a.jpg', dest('a.jpg'), { fetchImpl: okFetch }), true)
    assert.equal(fs.readFileSync(dest('a.jpg'), 'utf8'), 'JPEGDATA')
    let called = 0
    const spy = async () => { called++; return okFetch() }
    assert.equal(await tmdbCache.downloadImage('https://evil.example/a.jpg', dest('b.jpg'), { fetchImpl: spy }), false)
    assert.equal(await tmdbCache.downloadImage('http://image.tmdb.org/a.jpg', dest('c.jpg'), { fetchImpl: spy }), false)
    assert.equal(called, 0)
    assert.equal(await tmdbCache.downloadImage('https://image.tmdb.org/a.jpg', dest('d.jpg'), { fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'text/html' }, body: Buffer.from('x') }) }), false)
    assert.equal(await tmdbCache.downloadImage('https://image.tmdb.org/a.jpg', dest('e.jpg'), { fetchImpl: async () => fakeResponse({ headers: { 'content-type': 'image/jpeg', 'content-length': String(50 * 1024 * 1024) }, body: Buffer.alloc(1) }) }), false)
    for (const n of ['b.jpg', 'c.jpg', 'd.jpg', 'e.jpg']) assert.equal(fs.existsSync(dest(n)), false, n + ' was not written')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
