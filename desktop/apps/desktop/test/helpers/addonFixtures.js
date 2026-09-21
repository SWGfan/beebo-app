'use strict'
// Shared helpers for the add-on / Speech Pack tests: a tiny local file server (so "downloads" never
// leave this machine), zip and tar.gz builders, a fake settings store, and a manager wired to a fake
// Speech Pack catalog whose engine and models are just small files (the fake whisper/ffmpeg scripts in
// test/fixtures/speech do the "work").
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..', '..'), 'package.json'))

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const tmpDir = (p = 'beebo-addon-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p))

function memStore(initial = {}) {
  const data = { ...initial }
  return { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, data }
}

// ------------------------------------------------------------------ archives
function buildZip(entries) {
  const { crc32 } = localRequire('./electron/addons/archive')
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const raw = Buffer.from(e.data)
    const method = e.method === 0 ? 0 : 8
    const body = method === 0 ? raw : zlib.deflateRawSync(raw)
    const crc = e.badCrc ? 1234 : crc32(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, name, body)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function buildTarGz(entries) {
  const blocks = []
  for (const e of entries) {
    const h = Buffer.alloc(512)
    h.write(e.name, 0, 100)
    h.write('0000644\0', 100)
    const data = e.type === '2' ? Buffer.alloc(0) : Buffer.from(e.data || '')
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write(e.type || '0', 156)
    if (e.link) h.write(e.link, 157, 100)
    h.write('ustar\0', 257)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

// -------------------------------------------------------------- local server
// routes: { '/path': Buffer | { body, status, headers, redirect } }; honours Range like a CDN does.
function startFileServer(routes, { ignoreRange = false } = {}) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, range: req.headers.range || null })
    const r = routes[req.url.split('?')[0]]
    if (!r) { res.writeHead(404); return res.end('nope') }
    const spec = Buffer.isBuffer(r) ? { body: r } : r
    if (spec.redirect) { res.writeHead(302, { Location: spec.redirect }); return res.end() }
    const body = spec.body
    const m = !ignoreRange && /^bytes=(\d+)-$/.exec(req.headers.range || '')
    if (m) {
      const from = Number(m[1])
      if (from >= body.length) { res.writeHead(416); return res.end() }
      res.writeHead(206, { 'Content-Length': body.length - from, 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` })
      return res.end(body.subarray(from))
    }
    const headers = { 'Content-Length': spec.lengthHeader != null ? spec.lengthHeader : body.length, ...(spec.headers || {}) }
    res.writeHead(spec.status || 200, headers)
    if (spec.cutAfter != null) { res.write(body.subarray(0, spec.cutAfter)); return setTimeout(() => res.destroy(), 30) }
    res.end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({ port, base: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(r)) })
  }))
}

// ------------------------------------------------- fake Speech Pack catalog
const FIXTURES = path.join(path.resolve(__dirname, '..'), 'fixtures', 'speech')
const FAKE_WHISPER = path.join(FIXTURES, 'fake-whisper.js')
const FAKE_FFMPEG = path.join(FIXTURES, 'fake-ffmpeg.js')

/**
 * spawnFn for the queue: maps the "programs" to the fake node scripts, keeps the real argument lists.
 * Records every call in `calls` ({ program, args, shell }).
 */
function fakeSpawn(calls = []) {
  return (exe, args, opts = {}) => {
    const name = path.basename(String(exe))
    const isWhisper = /whisper/i.test(name)
    const isFfmpeg = /ffmpeg/i.test(name)
    const isFfprobe = /ffprobe/i.test(name)
    calls.push({ program: isWhisper ? 'whisper' : isFfmpeg ? 'ffmpeg' : isFfprobe ? 'ffprobe' : name, args: [...args], shell: opts.shell, env: opts.env, cwd: opts.cwd })
    const script = isWhisper ? FAKE_WHISPER : FAKE_FFMPEG
    return spawn(process.execPath, [script, ...(isFfprobe ? ['--probe'] : []), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env } })
  }
}

const ENGINE_BYTES = Buffer.from('fake whisper engine binary')
const MODELS = {
  'model-base.en': Buffer.from('fake-model base.en'),
  'model-base': Buffer.from('fake-model base multilingual'),
  'model-tiny.en': Buffer.from('fake-model tiny.en SLOW'),
  'model-small.en': Buffer.from('fake-model small.en FAIL')
}

function fakeCatalog() {
  const comp = (id, name, group, required, buf, fileName, extra = {}) => ({
    id, name, group, required, kind: 'file', platform: 'any', version: 'test-1', licence: 'MIT',
    url: `https://github.com/example/${fileName}`, size: buf.length, sha256: sha256(buf), fileName, ...extra
  })
  return [{
    schema: 1, id: 'speech-pack', name: 'Speech Pack (test)', version: '1', licence: 'MIT', allowedHosts: ['github.com'],
    components: [
      comp('engine', 'Engine', 'engine', true, ENGINE_BYTES, 'whisper-cli.exe'),
      ...Object.entries(MODELS).map(([id, buf]) => comp(id, id, 'model', false, buf, `ggml-${id.slice(6)}.bin`))
    ]
  }]
}

/** A real add-on manager whose "downloads" come from a local server instead of github.com. */
async function fakeSpeechManager({ dir = tmpDir('beebo-addons-'), extraRoutes = {}, downloadOptions = {} } = {}) {
  const { createAddonManager } = localRequire('./electron/addons')
  const { downloadVerified } = localRequire('./electron/addons/download')
  const routes = { '/whisper-cli.exe': ENGINE_BYTES, ...extraRoutes }
  for (const [id, buf] of Object.entries(MODELS)) routes[`/ggml-${id.slice(6)}.bin`] = buf
  const srv = await startFileServer(routes)
  const catalog = fakeCatalog()
  const manager = createAddonManager({
    dir, catalog, platform: 'win32-x64',
    download: (o) => downloadVerified({ ...o, url: srv.base + '/' + path.posix.basename(new URL(o.url).pathname), allowLoopbackHttp: true, ...downloadOptions })
  })
  return { manager, dir, srv, catalog }
}

module.exports = { sha256, tmpDir, memStore, buildZip, buildTarGz, startFileServer, fakeCatalog, fakeSpawn, fakeSpeechManager, ENGINE_BYTES, MODELS, FAKE_WHISPER, FAKE_FFMPEG, localRequire }
