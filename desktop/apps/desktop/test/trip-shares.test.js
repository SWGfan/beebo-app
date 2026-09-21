'use strict'
// Trip sharing (electron/tripShares.js, tripShareApi.js, tripSharePage.js, tripShareMedia.js):
// link tokens, expiry, revocation, path traversal, XSS in titles and captions, location stripping,
// rate limits, and the resumable upload. Everything runs against a temp folder; nothing needs
// Electron or a phone.
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')

const { createTripShares, TOKEN_RE } = require('../electron/tripShares')
const api = require('../electron/tripShareApi')
const media = require('../electron/tripShareMedia')
const page = require('../electron/tripSharePage')

/* ------------------------------ fixtures ------------------------------ */

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]) }

const GPS_MARK = 'GPSLatitude=51.5074N GPSLongitude=0.1278W'

/** A tiny but structurally valid JPEG: JFIF, an Exif segment holding a GPS marker, then a scan. */
function jpeg({ gps = true, tag = 'A' } = {}) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0]), u16(16), Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])])
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('MM\0*' + GPS_MARK, 'latin1')])
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(exif.length + 2), exif])
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb]), u16(67), Buffer.alloc(65, 1)])
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), u16(8), Buffer.from([1, 1, 0, 0, 0x3f, 0]), Buffer.from('IMAGEDATA-' + tag, 'latin1'), Buffer.from([0xff, 0xd9])])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, ...(gps ? [app1] : []), dqt, sos])
}

function png({ gps = true } = {}) {
  const chunk = (type, data) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    chunk('IHDR', Buffer.alloc(13, 1)),
    ...(gps ? [chunk('eXIf', Buffer.from('II*\0' + GPS_MARK, 'latin1')), chunk('tEXt', Buffer.from('Comment\0' + GPS_MARK, 'latin1'))] : []),
    chunk('IDAT', Buffer.from('PIXELS', 'latin1')),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** An MP4 whose moov holds a "©xyz" location atom, followed by the media data. */
function mp4({ location = true, keyed = false } = {}) {
  const ftyp = box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2'))
  const loc = box('©xyz', u16(20), u16(0x15c7), Buffer.from('+51.5074-000.1278/', 'latin1'))
  const udta = box('udta', ...(location ? [loc] : []), box('name', Buffer.from('hello')))
  const meta = keyed ? box('meta', Buffer.alloc(4), box('keys', Buffer.from('com.apple.quicktime.location.ISO6709'))) : Buffer.alloc(0)
  const moov = box('moov', box('mvhd', Buffer.alloc(100)), udta, meta)
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.from('VIDEODATA', 'latin1'))])
}

function mp3() { return Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0', 'latin1'), Buffer.alloc(200, 7)]) }

const jsonReq = (obj) => Readable.from([Buffer.from(JSON.stringify(obj))])
const chunkReq = (data, headers = {}) => { const r = Readable.from([data]); r.headers = { 'content-length': String(data.length), ...headers }; return r }

async function harness(opts = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trip-shares-'))
  let t = 1_750_000_000_000
  const svc = createTripShares({ dataDir: dir, now: () => t, freeSpace: async () => 1e13, ...opts })
  return {
    dir, svc,
    now: () => t,
    tick: (ms) => { t += ms },
    cleanup: async () => { await svc.flush(); await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
  }
}

const owner = { id: 'u-owner', isAdmin: true }
const mum = { id: 'u-mum', isAdmin: false }

/** Send [buf] through begin / chunk / finish the way the phone does, in [piece]-byte chunks. */
async function upload(svc, user, tripId, kind, buf, { piece = 64 * 1024, stopAfter = Infinity } = {}) {
  const hash = sha(buf)
  const begun = await svc.begin(user, { tripId, kind, sha256: hash, size: buf.length })
  if (begun.status === 'done') return { begun, hash }
  let offset = begun.offset
  let sent = 0
  while (offset < buf.length && sent < stopAfter) {
    const part = buf.subarray(offset, Math.min(buf.length, offset + piece))
    const r = await svc.chunk(user, chunkReq(part, { 'x-chunk-sha256': sha(part) }), new URLSearchParams({ uploadId: begun.uploadId, offset: String(offset) }))
    offset = r.offset
    sent++
  }
  if (offset < buf.length) return { begun, hash, offset }
  const done = await svc.finish(user, { uploadId: begun.uploadId })
  return { begun, done, hash }
}

const photoItem = (hash, extra = {}) => ({ kind: 'photo', at: 1, title: '', media: { sha: hash, w: 800, h: 600, caption: 'Sunset', ...extra } })
const manifest = (items, extra = {}) => ({ title: 'Lake week', dates: '4 to 11 July', crew: 'With Ana and Ben', stats: ['3 games'], days: [{ label: 'Saturday 4 July', items }], ...extra })

async function shareWith(h, user, tripId, items, options = {}, extra = {}) {
  return h.svc.createShare(user, { tripId, manifest: manifest(items, extra), options })
}

function request(server, pathAndQuery, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address()
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method, headers }, (res) => {
      const parts = []
      res.on('data', (c) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function publicServer(h, ctxExtra = {}) {
  // Each server gets its own generous limiters so one test's misses never block the next test's requests.
  const limiters = { all: api.createRateLimiter({ windowMs: 60000, max: 100000 }), bad: api.createRateLimiter({ windowMs: 600000, max: 100000 }) }
  const ctx = { services: { shares: h.svc }, clientIp: (req) => req.headers['x-test-ip'] || '10.0.0.1', limiters, ...ctxExtra }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    api.handlePublic(ctx, req, res, url).catch((e) => { res.statusCode = 500; res.end(String(e)) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return server
}

/* ------------------------------ tokens ------------------------------ */

test('tokens are 256 bits from a secure source, all different, and only their hash is stored', async () => {
  const h = await harness()
  try {
    h.svc.setSettings({ maxLiveShares: 500 })
    const seen = new Set()
    let first
    for (let i = 0; i < 60; i++) {
      const out = await h.svc.createShare(owner, { tripId: 't1', manifest: manifest([]), options: {} })
      assert.match(out.token, TOKEN_RE)
      assert.equal(Buffer.from(out.token, 'base64url').length, 32, '32 random bytes = 256 bits')
      assert.ok(!seen.has(out.token))
      seen.add(out.token)
      first = first || out
    }
    await h.svc.flush()
    const stored = await fsp.readFile(path.join(h.dir, 'index.json'), 'utf8')
    for (const token of seen) assert.ok(!stored.includes(token), 'the index never holds a working token')
    assert.ok(stored.includes(sha(first.token)), 'only the SHA-256 of the token is kept')
    const shareFile = await fsp.readFile(path.join(h.dir, 'shares', first.share.id + '.json'), 'utf8')
    assert.ok(!shareFile.includes(first.token))
  } finally { await h.cleanup() }
})

test('the token comes from crypto.randomBytes(32)', async () => {
  const asked = []
  const h = await harness({ randomBytes: (n) => { asked.push(n); return crypto.randomBytes(n) } })
  try {
    await h.svc.createShare(owner, { tripId: 't1', manifest: manifest([]), options: {} })
    assert.ok(asked.includes(32))
  } finally { await h.cleanup() }
})

test('a malformed, short or guessed token never resolves', async () => {
  const h = await harness()
  try {
    const out = await h.svc.createShare(owner, { tripId: 't1', manifest: manifest([]), options: {} })
    assert.ok(h.svc.resolve(out.token))
    for (const bad of ['', 'abc', out.token.slice(1), out.token + 'A', out.token.replace(/.$/, out.token.endsWith('A') ? 'B' : 'A'), '../'.repeat(15), null, undefined, 42, {}]) {
      assert.equal(h.svc.resolve(bad), null, String(bad))
    }
  } finally { await h.cleanup() }
})

/* ------------------------------ expiry ------------------------------ */

test('a link expires, defaults to 30 days, is capped by the owner and can be extended only while live', async () => {
  const h = await harness()
  try {
    const out = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: {} })
    assert.equal(out.share.expiresAt - h.now(), 30 * 24 * 3600 * 1000)
    h.tick(29 * 24 * 3600 * 1000)
    assert.ok(h.svc.resolve(out.token), 'still live on day 29')
    h.tick(2 * 24 * 3600 * 1000)
    assert.equal(h.svc.resolve(out.token), null, 'expired')
    await assert.rejects(h.svc.extend(mum, out.share.id, 24), { code: 'link_expired' })

    const short = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: { expiresInHours: 24 } })
    assert.equal(short.share.expiresAt - h.now(), 24 * 3600 * 1000)
    const ext = await h.svc.extend(mum, short.share.id, 24 * 5)
    assert.equal(ext.share.expiresAt - h.now(), 5 * 24 * 3600 * 1000)

    h.svc.setSettings({ maxExpiryHours: 48 })
    const capped = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: { expiresInHours: 24 * 90 } })
    assert.equal(capped.share.expiresAt - h.now(), 48 * 3600 * 1000, 'the owner cap wins over the sender')
    const tiny = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: { expiresInHours: -5 } })
    assert.ok(tiny.share.expiresAt > h.now())
  } finally { await h.cleanup() }
})

test('a link with a song defaults to 48 hours', async () => {
  const h = await harness()
  try {
    const song = await upload(h.svc, mum, 't1', 'audio', mp3())
    const out = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([], { song: { sha: song.hash, title: 'Our song' } }), options: { includeSong: true, rightsAck: true } })
    assert.equal(out.share.expiresAt - h.now(), 48 * 3600 * 1000)
  } finally { await h.cleanup() }
})

/* ------------------------------ revocation ------------------------------ */

test('revoking kills the link at once, looks like any unknown link, and deletes its files', async () => {
  const h = await harness()
  try {
    const img = jpeg({ gps: false })
    const up = await upload(h.svc, mum, 't1', 'photo', img)
    const out = await shareWith(h, mum, 't1', [photoItem(up.hash)])
    const server = await publicServer(h)
    try {
      const ok = await request(server, out.path)
      assert.equal(ok.status, 200)
      const media0 = await request(server, out.path + '/m/0')
      assert.equal(media0.status, 200)
      assert.ok(fs.existsSync(path.join(h.dir, 'media', out.share.pkg, up.hash)))

      await h.svc.revoke(mum, out.share.id)
      const gone = await request(server, out.path)
      const unknown = await request(server, '/trip/' + crypto.randomBytes(32).toString('base64url'))
      assert.equal(gone.status, 404)
      assert.equal(gone.status, unknown.status)
      assert.equal(gone.body.toString(), unknown.body.toString(), 'revoked and unknown are indistinguishable')
      assert.equal((await request(server, out.path + '/m/0')).status, 404)
      assert.ok(!fs.existsSync(path.join(h.dir, 'media', out.share.pkg, up.hash)), 'the photo is deleted from the PC')
      assert.equal(h.svc.list(mum)[0].status, 'revoked')
    } finally { server.close() }
  } finally { await h.cleanup() }
})

test('a photo still needed by another live link of the same trip is kept', async () => {
  const h = await harness()
  try {
    const up = await upload(h.svc, mum, 't1', 'photo', jpeg({ gps: false }))
    const a = await shareWith(h, mum, 't1', [photoItem(up.hash)])
    const b = await shareWith(h, mum, 't1', [photoItem(up.hash)])
    await h.svc.revoke(mum, a.share.id)
    assert.ok(fs.existsSync(path.join(h.dir, 'media', a.share.pkg, up.hash)))
    await h.svc.revoke(mum, b.share.id)
    assert.ok(!fs.existsSync(path.join(h.dir, 'media', a.share.pkg, up.hash)))
  } finally { await h.cleanup() }
})

test('expired links lose their files at the next sweep and their records after 30 days', async () => {
  const h = await harness()
  try {
    const up = await upload(h.svc, mum, 't1', 'photo', jpeg({ gps: false }))
    const out = await shareWith(h, mum, 't1', [photoItem(up.hash)], { expiresInHours: 24 })
    h.tick(2 * 24 * 3600 * 1000)
    await h.svc.sweep()
    assert.ok(!fs.existsSync(path.join(h.dir, 'media', out.share.pkg, up.hash)))
    assert.equal(h.svc.list(mum).length, 1, 'the record is kept for a while so the owner can see it ended')
    h.tick(31 * 24 * 3600 * 1000)
    await h.svc.sweep()
    assert.equal(h.svc.list(mum).length, 0)
  } finally { await h.cleanup() }
})

test('owners see and revoke everything, other people only their own', async () => {
  const h = await harness()
  try {
    const dad = { id: 'u-dad', isAdmin: false }
    const a = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: {} })
    await h.svc.createShare(dad, { tripId: 't2', manifest: manifest([]), options: {} })
    assert.equal(h.svc.list(mum).length, 1)
    assert.equal(h.svc.list(dad, { all: true }).length, 1, 'non-owners cannot ask for everyone')
    assert.equal(h.svc.list(owner, { all: true }).length, 2)
    await assert.rejects(h.svc.revoke(dad, a.share.id), { code: 'link_not_found' })
    await h.svc.revoke(owner, a.share.id)
    assert.equal(h.svc.resolve(a.token), null)
  } finally { await h.cleanup() }
})

test('deleting a trip removes its links, files and half-finished uploads', async () => {
  const h = await harness()
  try {
    const up = await upload(h.svc, mum, 't1', 'photo', jpeg({ gps: false }))
    const out = await shareWith(h, mum, 't1', [photoItem(up.hash)])
    const half = jpeg({ tag: 'B' })
    await upload(h.svc, mum, 't1', 'photo', Buffer.concat([half, Buffer.alloc(200000, 3)]), { piece: 1000, stopAfter: 2 })
    await h.svc.deleteTrip(mum, { tripId: 't1' })
    assert.equal(h.svc.resolve(out.token), null)
    assert.ok(!fs.existsSync(path.join(h.dir, 'media', out.share.pkg)))
    assert.deepEqual(fs.readdirSync(path.join(h.dir, 'incoming')), [])
    assert.equal((await h.svc.packages(owner, { all: true })).length, 0)
    await assert.rejects(h.svc.deleteTrip(mum, { tripId: 't1' }), { code: 'trip_not_found' })
  } finally { await h.cleanup() }
})

test('the owner can switch trip links off for the whole PC', async () => {
  const h = await harness()
  try {
    const out = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: {} })
    h.svc.setSettings({ enabled: false })
    assert.equal(h.svc.resolve(out.token), null)
    await assert.rejects(h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha('x'), size: 5 }), { code: 'trip_sharing_off' })
    await assert.rejects(h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: {} }), { code: 'trip_sharing_off' })
    h.svc.setSettings({ enabled: true })
    assert.ok(h.svc.resolve(out.token))
  } finally { await h.cleanup() }
})

test('settings are clamped to sane bounds', async () => {
  const h = await harness()
  try {
    const s = h.svc.setSettings({ maxStorageBytes: 1, maxVideoBytes: 1e15, defaultExpiryHours: 99999, maxExpiryHours: 'x', maxLiveShares: -3 })
    assert.ok(s.maxStorageBytes >= 100 * 1024 * 1024)
    assert.ok(s.maxVideoBytes <= 4 * 1024 * 1024 * 1024)
    assert.ok(s.defaultExpiryHours <= s.maxExpiryHours)
    assert.ok(s.maxLiveShares >= 1)
  } finally { await h.cleanup() }
})

/* ------------------------------ path traversal ------------------------------ */

test('nothing under /trip/ can reach another file or list a directory', async () => {
  const h = await harness()
  const server = await publicServer(h)
  try {
    const up = await upload(h.svc, mum, 't1', 'photo', jpeg({ gps: false }))
    const out = await shareWith(h, mum, 't1', [photoItem(up.hash)])
    const token = out.token
    const bad = [
      '/trip', '/trip/', '/trip//', '/trip/index.json', '/trip/..', '/trip/../index.json', '/trip/%2e%2e/index.json',
      `/trip/${token}/m/..%2f..%2findex.json`, `/trip/${token}/m/../../index.json`, `/trip/${token}/..`,
      `/trip/${token}/m/1`, `/trip/${token}/m/99999`, `/trip/${token}/m/-1`, `/trip/${token}/m/0x0`, `/trip/${token}/m/`, `/trip/${token}/m/0/extra`,
      `/trip/${token}/${up.hash}`, `/trip/${token}/media/${up.hash}`, `/trip/${token}%00`, `/trip/${token}/m/0%00.jpg`,
      `/trip/${'A'.repeat(43)}`, `/trip/${'A'.repeat(200)}`, '/trip/../../../../windows/win.ini', '/trip/..%5c..%5cwin.ini'
    ]
    for (const p of bad) {
      const r = await request(server, p)
      assert.equal(r.status, 404, `${p} -> ${r.status}`)
      assert.ok(!/index\.json|"shares"|"packages"|win\.ini/.test(r.body.toString()), p)
    }
    // Media is only ever found through the share's own numbered list.
    assert.equal((await request(server, `/trip/${token}/m/0`, { headers: { 'x-test-ip': '10.9.9.9' } })).status, 200)
  } finally { server.close(); await h.cleanup() }
})

test('POST and other methods are refused on public routes', async () => {
  const h = await harness()
  const server = await publicServer(h)
  try {
    const out = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: {} })
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await request(server, out.path, { method })
      assert.equal(r.status, 405, method)
      assert.equal(r.headers.allow, 'GET, HEAD')
    }
  } finally { server.close(); await h.cleanup() }
})

/* ------------------------------ XSS ------------------------------ */

const EVIL = '<script>alert(1)</script>"><img src=x onerror=alert(2)>\'`javascript:alert(3)'

test('every string on the page is escaped and the page has no script at all', async () => {
  const h = await harness()
  try {
    const img = await upload(h.svc, mum, 't1', 'photo', jpeg({ gps: false }))
    const clip = await upload(h.svc, mum, 't1', 'video', mp4({ location: false }))
    const song = await upload(h.svc, mum, 't1', 'audio', mp3())
    const items = [
      photoItem(img.hash, { caption: EVIL }),
      { kind: 'video', at: 2, media: { sha: clip.hash, caption: EVIL } },
      { kind: 'story', at: 3, title: EVIL, text: EVIL + '\n' + EVIL, lines: [EVIL] },
      { kind: 'game', at: 4, title: EVIL, lines: [EVIL, EVIL] }
    ]
    const out = await h.svc.createShare(mum, {
      tripId: 't1',
      manifest: {
        title: EVIL, dates: EVIL, crew: EVIL, stats: [EVIL],
        days: [{ label: EVIL, items }], undated: [{ kind: 'badge', title: EVIL, lines: [EVIL] }],
        places: [{ label: EVIL, lat: 1, lng: 2 }], song: { sha: song.hash, title: EVIL }
      },
      options: { includeLocation: true, includeSong: true, rightsAck: true }
    })
    const server = await publicServer(h)
    try {
      const r = await request(server, out.path)
      const html = r.body.toString()
      assert.equal(r.status, 200)
      assert.ok(!/<script/i.test(html), 'no script element')
      assert.ok(!html.includes('<img src=x'), 'the injected tag is not markup')
      // Read every real tag and its attribute NAMES (quoted values may safely contain the escaped text).
      for (const tag of html.match(/<[a-zA-Z][^>]*>/g) || []) {
        const names = [...tag.matchAll(/\s([a-zA-Z_:-][\w:.-]*)(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/g)].map((m) => m[1].toLowerCase())
        assert.ok(!names.some((n) => n.startsWith('on')), 'no event handler attribute in ' + tag.slice(0, 80))
        assert.ok(!/href="javascript:/i.test(tag) && !/src="javascript:/i.test(tag))
      }
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
      // Every attribute value that carries text is double-quoted and escaped.
      assert.ok(!html.includes('alt="<') && !html.includes('alt=""><'))
      const csp = r.headers['content-security-policy']
      assert.match(csp, /default-src 'none'/)
      assert.ok(!/script-src/.test(csp) && !/unsafe-eval/.test(csp), 'the policy allows no scripts')
      assert.match(csp, /frame-ancestors 'none'/)
    } finally { server.close() }
  } finally { await h.cleanup() }
})

test('the manifest is cleaned: lengths capped, controls and bidi overrides stripped, unknown kinds dropped', () => {
  const lookup = () => null
  const long = 'x'.repeat(5000)
  const { page: p } = page.sanitizeManifest({
    title: 'A B‮C⁦D', dates: long, crew: null, stats: new Array(50).fill('s'), unknown: '<b>',
    days: [{ label: 'd', items: [{ kind: 'story', title: long, text: long, lines: new Array(100).fill(long) }, { kind: 'evil', title: 'no' }, 'str', null] }]
  }, { lookup })
  assert.equal(p.title, 'A B C D')
  assert.ok(p.dates.length <= page.LIMITS.dates)
  assert.equal(p.stats.length, page.LIMITS.stats)
  assert.equal(p.days[0].items.length, 1, 'unknown kinds are dropped')
  const it = p.days[0].items[0]
  assert.ok(it.title.length <= page.LIMITS.itemTitle && it.text.length <= page.LIMITS.text && it.lines.length <= page.LIMITS.lines)
  assert.ok(!('unknown' in p))
  assert.equal(page.sanitizeManifest(null, { lookup }).page.title, 'Our trip')
})

test('esc() covers every character that matters in text and quoted attributes', () => {
  assert.equal(page.esc(`<>&"'\``), '&lt;&gt;&amp;&quot;&#39;&#96;')
  assert.equal(page.esc(null), '')
  assert.equal(page.esc(42), '42')
})

test('a photo reference to a file the PC does not hold is refused, not silently shown', async () => {
  const h = await harness()
  try {
    await assert.rejects(shareWith(h, mum, 't1', [photoItem(sha('never uploaded'))]), (e) => e.code === 'media_missing' && e.extra.missing.length === 1)
    // A photo item may not point at a video, nor a story item smuggle a media reference.
    const clip = await upload(h.svc, mum, 't1', 'video', mp4({ location: false }))
    await assert.rejects(shareWith(h, mum, 't1', [photoItem(clip.hash)]), { code: 'media_missing' })
    const ok = await shareWith(h, mum, 't1', [{ kind: 'story', title: 'x', media: { sha: clip.hash } }])
    const data = await h.svc.shareData(h.svc.resolve(ok.token))
    assert.equal(data.mediaRefs.length, 0)
  } finally { await h.cleanup() }
})

/* ------------------------------ page and headers ------------------------------ */

test('the page is view-only, lazy, large-text, robots-blocked and credits Beebo', async () => {
  const h = await harness()
  const server = await publicServer(h)
  try {
    const img = await upload(h.svc, mum, 't1', 'photo', jpeg({ gps: false }))
    const clip = await upload(h.svc, mum, 't1', 'video', mp4({ location: false }))
    const out = await shareWith(h, mum, 't1', [photoItem(img.hash), { kind: 'video', at: 2, media: { sha: clip.hash } }, { kind: 'story', title: 'The bear', text: 'A big one.' }])
    const r = await request(server, out.path)
    const html = r.body.toString()
    assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/)
    assert.match(html, /loading="lazy"/)
    assert.match(html, /preload="none"/)
    assert.match(html, /Made with Beebo/)
    assert.match(html, /font-size:clamp\(20px/)
    assert.match(html, /Lake week/)
    assert.match(html, /The bear/)
    assert.ok(!/<form|<input|<button|<textarea/i.test(html), 'no controls that could change anything')
    assert.ok(!/https?:\/\/(?!www\.openstreetmap\.org)/i.test(html.replace(/<meta[^>]*>/g, '')), 'no third-party resources')
    assert.ok(!/<link\b|@import|url\(/i.test(html))
    assert.match(r.headers['x-robots-tag'], /noindex/)
    assert.equal(r.headers['referrer-policy'], 'no-referrer')
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.equal(r.headers['x-frame-options'], 'DENY')
    const robots = await request(server, '/robots.txt')
    assert.match(robots.body.toString(), /Disallow: \//)
    assert.ok(!page.renderPage({ page: { title: 't', dates: '', crew: '', stats: [], days: [], undated: [], places: [], song: null }, mediaRefs: [], expiresAt: 0, options: {} }, () => '').includes('<script'))
  } finally { server.close(); await h.cleanup() }
})

test('the page shows the expiry date and a friendly note when the trip is empty', () => {
  const html = page.renderPage({ page: { title: 'Empty', dates: '', crew: '', stats: [], days: [], undated: [], places: [], song: null }, mediaRefs: [], expiresAt: Date.UTC(2030, 0, 15), options: {} }, () => '')
  assert.match(html, /January 15, 2030/)
  assert.match(html, /Nothing has been added/)
})

test('a video can be sought with Range requests and reports its own type', async () => {
  const h = await harness()
  const server = await publicServer(h)
  try {
    const clipBytes = mp4({ location: false })
    const clip = await upload(h.svc, mum, 't1', 'video', clipBytes)
    const out = await shareWith(h, mum, 't1', [{ kind: 'video', at: 1, media: { sha: clip.hash } }])
    const r = await request(server, out.path + '/m/0', { headers: { range: 'bytes=0-9' } })
    assert.equal(r.status, 206)
    assert.equal(r.headers['content-type'], 'video/mp4')
    assert.equal(r.body.length, 10)
    assert.equal((await request(server, out.path + '/m/0', { headers: { range: 'bytes=99999999-' } })).status, 416)
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; sandbox")
  } finally { server.close(); await h.cleanup() }
})

/* ------------------------------ location ------------------------------ */

test('cleanJpeg removes Exif and GPS, keeps the picture, and fails closed on a broken file', () => {
  const dirty = jpeg({ gps: true })
  assert.ok(dirty.includes(GPS_MARK))
  const clean = media.cleanJpeg(dirty)
  assert.ok(!clean.includes(GPS_MARK) && !clean.includes('Exif'))
  assert.ok(clean.includes('IMAGEDATA'), 'the scan data survives')
  assert.equal(clean[0], 0xff); assert.equal(clean[1], 0xd8)
  // A JPEG cut off inside the Exif segment cannot be cleaned, so nothing is served.
  assert.equal(media.cleanJpeg(dirty.subarray(0, 40)), null)
  assert.equal(media.cleanJpeg(Buffer.from('not a jpeg at all')), null)
})

test('cleanPng removes eXIf and text chunks and fails closed on a broken file', () => {
  const dirty = png({ gps: true })
  assert.ok(dirty.includes(GPS_MARK))
  const clean = media.cleanPng(dirty)
  assert.ok(!clean.includes(GPS_MARK) && !clean.includes('eXIf') && !clean.includes('tEXt'))
  assert.ok(clean.includes('PIXELS') && clean.includes('IEND'))
  assert.equal(media.cleanPng(dirty.subarray(0, dirty.length - 20)), null)
})

test('a link made without location serves photos with no GPS; one made with location keeps what the sender chose', async () => {
  const h = await harness()
  const server = await publicServer(h)
  try {
    const dirtyJpg = jpeg({ gps: true })
    const dirtyPng = png({ gps: true })
    const a = await upload(h.svc, mum, 't1', 'photo', dirtyJpg)
    const b = await upload(h.svc, mum, 't1', 'photo', dirtyPng)
    const items = [photoItem(a.hash), photoItem(b.hash)]
    const without = await shareWith(h, mum, 't1', items, {})
    for (const i of [0, 1]) {
      const r = await request(server, `${without.path}/m/${i}`)
      assert.equal(r.status, 200)
      assert.ok(!r.body.includes(GPS_MARK), `photo ${i} carries no position`)
      assert.ok(!r.body.includes('Exif\0\0'))
    }
    const withLoc = await shareWith(h, mum, 't1', items, { includeLocation: true })
    const r = await request(server, `${withLoc.path}/m/0`)
    assert.ok(r.body.includes(GPS_MARK), 'opted in: the file is served as sent')
  } finally { server.close(); await h.cleanup() }
})

test('hunt places appear only when the link was made with location, whatever the phone sent', async () => {
  const h = await harness()
  const server = await publicServer(h)
  try {
    const places = [{ label: 'Big rock', lat: 51.5074, lng: -0.1278 }]
    const off = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([], { places }), options: { includeLocation: false } })
    const on = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([], { places }), options: { includeLocation: true } })
    const htmlOff = (await request(server, off.path)).body.toString()
    const htmlOn = (await request(server, on.path)).body.toString()
    assert.ok(!htmlOff.includes('51.5074') && !htmlOff.includes('Big rock') && !/openstreetmap/.test(htmlOff))
    assert.ok(htmlOn.includes('51.5074') && htmlOn.includes('Big rock'))
    assert.deepEqual(off.share.options, { includeLocation: false, includeSong: false, viewOnly: true })
  } finally { server.close(); await h.cleanup() }
})

test('MP4 location atoms are blanked when a clip arrives, in place and at the same length', async () => {
  const h = await harness()
  try {
    const dirty = mp4({ location: true })
    assert.ok(dirty.includes(Buffer.from('+51.5074-000.1278/')))
    const up = await upload(h.svc, mum, 't1', 'video', dirty)
    const stored = await fsp.readFile(path.join(h.dir, 'media', Object.keys(h.svc._index().packages)[0], up.hash))
    assert.equal(stored.length, dirty.length)
    assert.ok(!stored.includes(Buffer.from('+51.5074')))
    assert.ok(!stored.includes(Buffer.from('©xyz', 'latin1')))
    assert.ok(stored.includes(Buffer.from('VIDEODATA')), 'the video data is untouched')
    assert.ok(stored.includes(Buffer.from('free')))
  } finally { await h.cleanup() }
})

test('a clip with keyed location metadata that cannot be blanked is refused', async () => {
  const h = await harness()
  try {
    await assert.rejects(upload(h.svc, mum, 't1', 'video', mp4({ location: false, keyed: true })), { code: 'unsupported_location_metadata' })
    assert.equal(fs.readdirSync(path.join(h.dir, 'incoming')).length, 0, 'the refused upload is deleted')
  } finally { await h.cleanup() }
})

/* ------------------------------ the song ------------------------------ */

test('a song needs the include-song option and the sender confirming they have the rights', async () => {
  const h = await harness()
  const server = await publicServer(h)
  try {
    const song = await upload(h.svc, mum, 't1', 'audio', mp3())
    const withSong = { song: { sha: song.hash, title: 'Campfire song' } }
    await assert.rejects(h.svc.createShare(mum, { tripId: 't1', manifest: manifest([], withSong), options: { includeSong: true } }), { code: 'rights_ack_required' })
    await assert.rejects(h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: { includeSong: true, rightsAck: true } }), { code: 'song_missing' })

    // Default: the song is dropped even if the phone sent it.
    const plain = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([], withSong), options: {} })
    const htmlPlain = (await request(server, plain.path)).body.toString()
    assert.ok(!/<audio/.test(htmlPlain) && !htmlPlain.includes('Campfire song'))
    const data = await h.svc.shareData(h.svc.resolve(plain.token))
    assert.ok(!data.mediaRefs.some((r) => r.kind === 'audio'))
    assert.equal((await request(server, plain.path + '/m/0')).status, 404)

    const yes = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([], withSong), options: { includeSong: true, rightsAck: true } })
    const html = (await request(server, yes.path)).body.toString()
    assert.match(html, /<audio controls preload="none" src="\/trip\/[^"]+\/m\/0"/)
    assert.match(html, /don.t pass it on/)
    const audio = await request(server, yes.path + '/m/0')
    assert.equal(audio.status, 200)
    assert.equal(audio.headers['content-type'], 'audio/mpeg')
    assert.equal(h.svc.list(mum).find((s) => s.id === yes.share.id).options.includeSong, true)

    // Turning the song link off deletes the audio; the plain link never depended on it.
    await h.svc.revoke(mum, yes.share.id)
    await h.svc.revoke(mum, plain.share.id)
    assert.ok(!fs.existsSync(path.join(h.dir, 'media', yes.share.pkg, song.hash)))
  } finally { server.close(); await h.cleanup() }
})

/* ------------------------------ rate limits ------------------------------ */

test('createRateLimiter counts per key inside a window, resets after it and stays bounded', () => {
  let t = 0
  const lim = api.createRateLimiter({ windowMs: 1000, max: 3, now: () => t, maxKeys: 10 })
  assert.deepEqual([1, 2, 3, 4].map(() => lim.take('a')), [true, true, true, false])
  assert.equal(lim.blocked('a'), true)
  assert.equal(lim.take('b'), true, 'another key is unaffected')
  assert.equal(lim.retryAfterSec('a'), 1)
  t = 1001
  assert.equal(lim.blocked('a'), false)
  assert.equal(lim.take('a'), true)
  for (let i = 0; i < 100; i++) lim.take('k' + i)
  assert.ok(lim.size() <= 11, 'the key table cannot be grown without limit')
})

test('guessing tokens is rate limited per viewer address and blocks even a correct token from that address', async () => {
  const h = await harness()
  let t = 1_000_000
  const limiters = { all: api.createRateLimiter({ windowMs: 60000, max: 1000, now: () => t }), bad: api.createRateLimiter({ windowMs: 600000, max: 20, now: () => t }) }
  const server = await publicServer(h, { limiters })
  try {
    const out = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: {} })
    const statuses = []
    for (let i = 0; i < 25; i++) statuses.push((await request(server, '/trip/' + crypto.randomBytes(32).toString('base64url'), { headers: { 'x-test-ip': '9.9.9.9' } })).status)
    assert.equal(statuses.slice(0, 20).every((s) => s === 404), true)
    assert.equal(statuses.slice(20).every((s) => s === 429), true, 'after 20 misses the address is stopped')
    const blocked = await request(server, out.path, { headers: { 'x-test-ip': '9.9.9.9' } })
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers['retry-after']) > 0)
    assert.equal((await request(server, out.path, { headers: { 'x-test-ip': '8.8.8.8' } })).status, 200, 'a different address is fine')
    t += 11 * 60 * 1000
    assert.equal((await request(server, out.path, { headers: { 'x-test-ip': '9.9.9.9' } })).status, 200, 'and the block lifts')
  } finally { server.close(); await h.cleanup() }
})

test('overall request volume from one address is limited too', async () => {
  const h = await harness()
  const limiters = { all: api.createRateLimiter({ windowMs: 60000, max: 5 }), bad: api.createRateLimiter({ windowMs: 600000, max: 20 }) }
  const server = await publicServer(h, { limiters })
  try {
    const out = await h.svc.createShare(mum, { tripId: 't1', manifest: manifest([]), options: {} })
    const codes = []
    for (let i = 0; i < 8; i++) codes.push((await request(server, out.path)).status)
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429])
  } finally { server.close(); await h.cleanup() }
})

/* ------------------------------ resumable upload ------------------------------ */

test('an upload resumes where it stopped, verifies every chunk and the whole file, and is stored once', async () => {
  const h = await harness()
  try {
    const big = Buffer.concat([jpeg({ gps: false }), crypto.randomBytes(300 * 1024)])
    const half = await upload(h.svc, mum, 't1', 'photo', big, { piece: 50 * 1024, stopAfter: 3 })
    assert.equal(half.offset, 150 * 1024)
    const again = await h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha(big), size: big.length })
    assert.equal(again.status, 'resume')
    assert.equal(again.offset, 150 * 1024, 'the PC says where to carry on')
    assert.equal((await h.svc.status(mum, again.uploadId)).offset, 150 * 1024)
    const done = await upload(h.svc, mum, 't1', 'photo', big, { piece: 50 * 1024 })
    assert.equal(done.done.status, 'saved')
    const dup = await h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha(big), size: big.length })
    assert.equal(dup.status, 'done')
    assert.equal(dup.duplicate, true)
    const chk = await h.svc.check(mum, { tripId: 't1', items: [{ sha256: sha(big), size: big.length }, { sha256: sha('other'), size: 1 }] })
    assert.deepEqual(chk.results.map((r) => r.have), [true, false])
    assert.equal(fs.readdirSync(path.join(h.dir, 'incoming')).length, 0)
  } finally { await h.cleanup() }
})

test('chunks must arrive at the exact current end and match their own checksum', async () => {
  const h = await harness()
  try {
    const buf = Buffer.concat([jpeg({ gps: false }), Buffer.alloc(5000, 9)])
    const begun = await h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha(buf), size: buf.length })
    const params = (offset) => new URLSearchParams({ uploadId: begun.uploadId, offset: String(offset) })
    await assert.rejects(h.svc.chunk(mum, chunkReq(buf.subarray(100, 200)), params(100)), (e) => e.status === 409 && e.code === 'offset_mismatch' && e.extra.offset === 0)
    await assert.rejects(h.svc.chunk(mum, chunkReq(buf.subarray(0, 100), { 'x-chunk-sha256': sha('damaged') }), params(0)), (e) => e.status === 422 && e.code === 'chunk_checksum_mismatch' && e.extra.offset === 0)
    await assert.rejects(h.svc.chunk(mum, chunkReq(Buffer.alloc(buf.length + 1)), params(0)), { code: 'too_much_data' })
    await assert.rejects(h.svc.finish(mum, { uploadId: begun.uploadId }), (e) => e.code === 'incomplete' && e.extra.offset === 0)
    const ok = await h.svc.chunk(mum, chunkReq(buf.subarray(0, 100), { 'x-chunk-sha256': sha(buf.subarray(0, 100)) }), params(0))
    assert.equal(ok.offset, 100)
  } finally { await h.cleanup() }
})

test('a file that does not match its declared hash is discarded and nothing is stored', async () => {
  const h = await harness()
  try {
    const real = Buffer.concat([jpeg({ gps: false }), Buffer.alloc(100, 1)])
    const begun = await h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha(Buffer.from('a different file')), size: real.length })
    await h.svc.chunk(mum, chunkReq(real), new URLSearchParams({ uploadId: begun.uploadId, offset: '0' }))
    await assert.rejects(h.svc.finish(mum, { uploadId: begun.uploadId }), { status: 422, code: 'checksum_mismatch' })
    assert.equal(fs.readdirSync(path.join(h.dir, 'incoming')).length, 0)
    assert.equal(Object.keys(h.svc._index().packages).length, 0)
  } finally { await h.cleanup() }
})

test('the type comes from the bytes: wrong kind, unknown formats and scripts are refused', async () => {
  const h = await harness()
  try {
    await assert.rejects(upload(h.svc, mum, 't1', 'photo', Buffer.from('<html><script>alert(1)</script></html>')), { status: 415, code: 'wrong_file_type' })
    await assert.rejects(upload(h.svc, mum, 't1', 'photo', mp4({ location: false })), { code: 'wrong_file_type' })
    await assert.rejects(upload(h.svc, mum, 't1', 'video', jpeg({ gps: false })), { code: 'wrong_file_type' })
    await assert.rejects(upload(h.svc, mum, 't1', 'audio', png()), { code: 'wrong_file_type' })
    await assert.rejects(upload(h.svc, mum, 't1', 'photo', Buffer.from('GIF89a' + 'x'.repeat(50))), { code: 'wrong_file_type' })
    await assert.rejects(h.svc.begin(mum, { tripId: 't1', kind: 'script', sha256: sha('x'), size: 5 }), { code: 'bad_kind' })
    assert.deepEqual(media.sniff(Buffer.from('%PDF-1.7 blah blah blah')), null)
    assert.equal(media.sniff(jpeg()).mime, 'image/jpeg')
    assert.equal(media.sniff(mp4()).kind, 'video')
  } finally { await h.cleanup() }
})

test('size limits, the storage cap and the file count cap are enforced before any byte is sent', async () => {
  const h = await harness()
  try {
    h.svc.setSettings({ maxPhotoBytes: 1024 * 1024, maxStorageBytes: 100 * 1024 * 1024 })
    await assert.rejects(h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha('a'), size: 2 * 1024 * 1024 }), (e) => e.status === 413 && e.code === 'file_too_large' && e.extra.limit === 1024 * 1024)
    await assert.rejects(h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: 'zz', size: 5 }), { code: 'bad_checksum' })
    await assert.rejects(h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha('a'), size: 0 }), { code: 'bad_size' })
    await assert.rejects(h.svc.begin(mum, { tripId: '../../x', kind: 'photo', sha256: sha('a'), size: 5 }), { code: 'bad_trip_id' })

    h.svc.setSettings({ maxVideoBytes: 200 * 1024 * 1024 })
    await assert.rejects(h.svc.begin(mum, { tripId: 't1', kind: 'video', sha256: sha('v'), size: 150 * 1024 * 1024 }), (e) => e.status === 507 && e.code === 'trip_storage_full')

    const tiny = await harness({ freeSpace: async () => 10 })
    try {
      await assert.rejects(tiny.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha('a'), size: 5 }), { status: 507, code: 'pc_disk_full' })
    } finally { await tiny.cleanup() }

    h.svc.setSettings({ maxMediaPerTrip: 2, maxStorageBytes: 10 * 1024 * 1024 * 1024 })
    await upload(h.svc, mum, 't2', 'photo', jpeg({ gps: false, tag: '1' }))
    await upload(h.svc, mum, 't2', 'photo', jpeg({ gps: false, tag: '2' }))
    await assert.rejects(h.svc.begin(mum, { tripId: 't2', kind: 'photo', sha256: sha('third'), size: 10 }), { code: 'too_many_files' })
    const u = await h.svc.usage()
    assert.ok(u.used > 0 && u.cap === 10 * 1024 * 1024 * 1024)
  } finally { await h.cleanup() }
})

test('one person can neither see nor finish another person\'s upload', async () => {
  const h = await harness()
  try {
    const buf = Buffer.concat([jpeg({ gps: false }), Buffer.alloc(100, 1)])
    const begun = await h.svc.begin(mum, { tripId: 't1', kind: 'photo', sha256: sha(buf), size: buf.length })
    const dad = { id: 'u-dad', isAdmin: false }
    await assert.rejects(h.svc.status(dad, begun.uploadId), { status: 404, code: 'upload_not_found' })
    await assert.rejects(h.svc.chunk(dad, chunkReq(buf), new URLSearchParams({ uploadId: begun.uploadId, offset: '0' })), { code: 'upload_not_found' })
    await assert.rejects(h.svc.finish(dad, { uploadId: begun.uploadId }), { code: 'upload_not_found' })
    await assert.rejects(h.svc.status(mum, '../../etc/passwd'), { code: 'bad_upload_id' })
    // The same trip id from two people is two different trips.
    const other = await upload(h.svc, dad, 't1', 'photo', buf)
    assert.equal(other.done.status, 'saved')
    assert.equal(Object.keys(h.svc._index().packages).length, 1 + 0, 'only the finished upload made a package')
    const dadShare = await h.svc.createShare(dad, { tripId: 't1', manifest: manifest([photoItem(other.hash)]), options: {} })
    await assert.rejects(h.svc.createShare(mum, { tripId: 't1', manifest: manifest([photoItem(other.hash)]), options: {} }), { code: 'media_missing' })
    assert.ok(dadShare.token)
  } finally { await h.cleanup() }
})

test('the index survives a restart and links keep working', async () => {
  const h = await harness()
  try {
    const up = await upload(h.svc, mum, 't1', 'photo', jpeg({ gps: false }))
    const out = await shareWith(h, mum, 't1', [photoItem(up.hash)])
    await h.svc.flush()
    const again = createTripShares({ dataDir: h.dir, now: h.now, freeSpace: async () => 1e13 })
    assert.ok(again.resolve(out.token))
    assert.equal(again.list(mum).length, 1)
    const file = await again.mediaFile(again.resolve(out.token), 0)
    assert.equal(file.kind, 'photo')
  } finally { await h.cleanup() }
})

/* ------------------------------ signed-in API ------------------------------ */

test('the signed-in API refuses people who may not back up, guests and wrong methods, and builds links from the configured address', async () => {
  const h = await harness()
  try {
    const sent = []
    const ctxFor = (user, allowed) => ({
      services: { shares: h.svc }, log: () => {}, send: (status, obj) => sent.push({ status, obj }), linkOrigin: () => 'https://smiths.beebo.tv',
      canShare: () => allowed
    })
    const run = async (ctx, p, method, user, body) => {
      const req = body === undefined ? Readable.from([]) : jsonReq(body)
      req.headers = {}
      const res = { setHeader() {} }
      await api.handle(ctx, req, res, new URL('http://x' + p), p.split('?')[0], method, user)
      return sent.pop()
    }
    assert.equal((await run(ctxFor(mum, false), '/api/trip-shares/status', 'GET', mum)).status, 403)
    assert.equal((await run(ctxFor({ ...mum, guest: true }, true), '/api/trip-shares/status', 'GET', { ...mum, guest: true })).status, 403)
    assert.equal((await run(ctxFor(null, true), '/api/trip-shares/status', 'GET', null)).status, 403)
    const ctx = ctxFor(mum, true)
    const st = await run(ctx, '/api/trip-shares/status', 'GET', mum)
    assert.equal(st.status, 200)
    assert.equal(st.obj.reachableAnywhere, true)
    assert.equal((await run(ctx, '/api/trip-shares/status', 'POST', mum)).status, 405)
    assert.equal((await run(ctx, '/api/trip-shares/settings', 'POST', mum, { enabled: false })).status, 403, 'only the owner changes settings')
    assert.equal((await run(ctxFor(owner, true), '/api/trip-shares/settings', 'POST', owner, { maxStorageBytes: 5 * 1024 ** 3 })).status, 200)
    const made = await run(ctx, '/api/trip-shares', 'POST', mum, { tripId: 't1', manifest: manifest([]), options: {} })
    assert.equal(made.status, 200)
    assert.ok(made.obj.url.startsWith('https://smiths.beebo.tv/trip/'))
    assert.ok(!('tokenHash' in made.obj.share))
    const listed = await run(ctx, '/api/trip-shares', 'GET', mum)
    assert.equal(listed.obj.shares.length, 1)
    assert.ok(!JSON.stringify(listed.obj).includes(made.obj.token), 'a listing never repeats the token')
    const revoked = await run(ctx, '/api/trip-shares/revoke', 'POST', mum, { id: made.obj.share.id })
    assert.equal(revoked.obj.share.status, 'revoked')
    assert.equal((await run(ctx, '/api/trip-shares/revoke', 'POST', mum, { id: 'nope' })).status, 404)
    assert.equal((await run(ctx, '/api/trip-shares/unknown', 'GET', mum)).status, 404)
  } finally { await h.cleanup() }
})

test('a LAN-only address is reported as home-only so the phone can warn the sender', async () => {
  const h = await harness()
  try {
    const sent = []
    const ctx = { services: { shares: h.svc }, send: (s, o) => sent.push(o), linkOrigin: () => 'http://192.168.1.20:47811', canShare: () => true }
    const req = jsonReq({ tripId: 't1', manifest: manifest([]), options: {} }); req.headers = {}
    await api.handle(ctx, req, { setHeader() {} }, new URL('http://x/api/trip-shares'), '/api/trip-shares', 'POST', mum)
    assert.equal(sent[0].reachableAnywhere, false)
    assert.ok(sent[0].url.startsWith('http://192.168.1.20:47811/trip/'))
  } finally { await h.cleanup() }
})
