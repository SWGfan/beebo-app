'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const art = require('../electron/artworkPicker')
const nfo = require('../electron/nfoImport')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-art-'))

function jpeg(width, height, extra = 0) {
  const sof = Buffer.alloc(19)
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), sof, Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), Buffer.alloc(extra, 7), Buffer.from([0xff, 0xd9])])
}
function jpegWithExif(width, height) {
  const body = Buffer.from('Exif\0\0GPS-SECRET-LOCATION')
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, body.length + 2]), body])
  const base = jpeg(width, height)
  return Buffer.concat([base.subarray(0, 2), exif, base.subarray(2)])
}
function png(width, height) {
  const b = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20)
  return b
}
function webp(width, height) {
  const b = Buffer.alloc(40)
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(32, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1')
  b.writeUInt32LE(10, 16)
  const w = width - 1
  const h = height - 1
  b[24] = w & 255; b[25] = (w >> 8) & 255; b[26] = (w >> 16) & 255
  b[27] = h & 255; b[28] = (h >> 8) & 255; b[29] = (h >> 16) & 255
  return b
}

test('imageInfo reads real headers and ignores the file name', () => {
  assert.deepEqual(art.imageInfo(jpeg(500, 750)), { type: 'jpeg', width: 500, height: 750 })
  assert.deepEqual(art.imageInfo(png(1000, 1500)), { type: 'png', width: 1000, height: 1500 })
  assert.deepEqual(art.imageInfo(webp(640, 960)), { type: 'webp', width: 640, height: 960 })
  for (const notImage of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from('MZ' + 'x'.repeat(100)), Buffer.from('<html><body>hi</body></html>' + ' '.repeat(40)), Buffer.from('GIF89a' + '\0'.repeat(40)), Buffer.alloc(0), Buffer.alloc(10), null, 'text']) {
    assert.equal(art.imageInfo(notImage), null)
  }
  assert.equal(art.imageInfo(jpeg(0, 0)), null, 'a zero-size picture is not one')
})

test('rejectReason: too small, too large, too many pixels, silly shapes, oversize files', () => {
  assert.equal(art.rejectReason(jpeg(500, 750), 'poster'), null)
  assert.match(art.rejectReason(jpeg(40, 60), 'poster'), /too small/)
  assert.match(art.rejectReason(png(60000, 60000), 'poster'), /too many pixels/)
  assert.match(art.rejectReason(png(9000, 9000), 'poster'), /too many pixels/)
  assert.match(art.rejectReason(jpeg(6000, 100), 'backdrop'), /too narrow or too wide/)
  assert.match(art.rejectReason(jpeg(500, 750, art.MAX_INPUT_BYTES + 1), 'poster'), /12 MB/)
  assert.match(art.rejectReason(Buffer.from('not an image at all, just text'), 'poster'), /not a JPEG, PNG or WebP/)
  assert.match(art.rejectReason(Buffer.alloc(0), 'poster'), /empty/)
})

test('normalise: uses the re-encoder output when it is a real JPEG within the size limit', async () => {
  const seen = []
  const out = await art.normalise(png(2000, 3000), 'poster', async (buf, target) => { seen.push(target); return jpeg(667, 1000) })
  assert.ok(out.bytes)
  assert.deepEqual(seen, [{ maxWidth: 1000, maxHeight: 1500 }])
  const backdrop = await art.normalise(jpeg(3840, 2160), 'backdrop', async (buf, target) => { seen.push(target); return jpeg(1920, 1080) })
  assert.deepEqual(seen[1], { maxWidth: 1920, maxHeight: 1080 })
  assert.ok(backdrop.bytes)
})

test('normalise: a re-encoder that returns junk, oversized pictures or nothing is not trusted', async () => {
  const junk = await art.normalise(jpeg(500, 750), 'poster', async () => Buffer.from('<html>evil</html>'.padEnd(60)))
  assert.ok(junk.bytes && art.imageInfo(junk.bytes), 'falls back to the stripped original JPEG, never to the junk')
  const bigger = await art.normalise(jpeg(500, 750), 'poster', async () => jpeg(4000, 6000))
  assert.deepEqual(art.imageInfo(bigger.bytes), { type: 'jpeg', width: 500, height: 750 })
  const throws = await art.normalise(jpeg(500, 750), 'poster', async () => { throw new Error('ffmpeg exploded') })
  assert.ok(throws.bytes)
})

test('normalise without ffmpeg: a JPEG loses its metadata (GPS, owner names), a PNG or WebP is refused', async () => {
  const withExif = jpegWithExif(500, 750)
  assert.ok(withExif.includes(Buffer.from('GPS-SECRET-LOCATION')))
  const out = await art.normalise(withExif, 'poster', null)
  assert.ok(!out.bytes.includes(Buffer.from('GPS-SECRET-LOCATION')))
  assert.equal(art.imageInfo(out.bytes).type, 'jpeg')
  assert.match((await art.normalise(png(500, 750), 'poster', null)).error, /needs ffmpeg/)
  assert.match((await art.normalise(webp(500, 750), 'poster', null)).error, /needs ffmpeg/)
  assert.ok((await art.normalise(Buffer.from('MZ' + 'x'.repeat(200)), 'poster', null)).error)
})

test('artworkFile serves only <32 hex>.jpg names that exist inside the artwork folder', () => {
  const dir = tmp()
  const name = art.saveBytes(dir, jpeg(500, 750))
  assert.match(name, /^[a-f0-9]{32}\.jpg$/)
  assert.equal(art.artworkFile(dir, name), path.join(dir, 'artwork', name))
  assert.equal(art.saveBytes(dir, jpeg(500, 750)), name, 'the same bytes are stored once')
  fs.writeFileSync(path.join(dir, 'secret.jpg'), 'x')
  for (const bad of ['../secret.jpg', '..\\secret.jpg', `${name}/../../secret.jpg`, 'secret.jpg', 'a'.repeat(32) + '.jpg', `${name.slice(0, 31)}.jpg`, `${name}.png`, '', null, { toString: () => name }]) {
    assert.equal(art.artworkFile(dir, bad), null, String(bad))
  }
  assert.equal(art.artworkFile('', name), null)
})

test('prune removes unreferenced pictures after a grace period and keeps the rest', () => {
  const dir = tmp()
  const keep = art.saveBytes(dir, jpeg(500, 750, 1))
  const drop = art.saveBytes(dir, jpeg(500, 750, 2))
  const fresh = art.saveBytes(dir, jpeg(500, 750, 3))
  const old = new Date(Date.now() - 3600 * 1000)
  for (const n of [keep, drop]) fs.utimesSync(path.join(dir, 'artwork', n), old, old)
  fs.writeFileSync(path.join(dir, 'artwork', 'notes.txt'), 'not touched')
  assert.equal(art.prune(dir, new Set([keep])), 1)
  assert.ok(art.artworkFile(dir, keep))
  assert.equal(art.artworkFile(dir, drop), null)
  assert.ok(art.artworkFile(dir, fresh), 'a picture made a moment ago is kept while its edit is being saved')
  assert.ok(fs.existsSync(path.join(dir, 'artwork', 'notes.txt')))
})

function service(dir, over = {}) {
  const calls = []
  const svc = art.createArtwork({
    getCacheDir: () => dir,
    getLocale: () => ({ language: 'fr-FR', region: 'FR' }),
    getApi: () => ({
      get: async (p, params) => {
        calls.push({ p, params })
        return { ok: true, data: { posters: [{ file_path: '/good.jpg', width: 2000, height: 3000, iso_639_1: 'fr', vote_average: 5.3, vote_count: 9 }, { file_path: '/../../etc/passwd', width: 1, height: 1 }, { file_path: 'nopath.jpg' }, { file_path: '/best.jpg', width: 1000, height: 1500, iso_639_1: null, vote_average: 7, vote_count: 30 }], backdrops: [{ file_path: '/bd.jpg', width: 3840, height: 2160, iso_639_1: null, vote_average: 5, vote_count: 3 }] } }
      }
    }),
    reencode: async (buf, target) => jpeg(Math.min(target.maxWidth, 800), Math.min(target.maxHeight, 1200)),
    fetchImage: async (url) => { calls.push({ url }); return png(2000, 3000) },
    ...over
  })
  return { svc, calls }
}

test('listTmdb: asks in the user language + English + no language, keeps only safe paths, sorts by score, and caches', async () => {
  const dir = tmp()
  const { svc, calls } = service(dir)
  const r = await svc.listTmdb('movie', 603)
  assert.equal(r.ok, true)
  assert.deepEqual(calls[0], { p: '/movie/603/images', params: { include_image_language: 'fr,en,null' } })
  assert.deepEqual(r.posters.map((p) => p.path), ['/best.jpg', '/good.jpg'])
  assert.deepEqual(r.backdrops.map((p) => p.path), ['/bd.jpg'])
  const again = await svc.listTmdb('movie', 603)
  assert.equal(again.cached, true)
  assert.equal(calls.filter((c) => c.p).length, 1, 'the second look uses the cache')
  const show = await svc.listTmdb('show', 1396)
  assert.equal(calls.find((c) => c.p === '/tv/1396/images') !== undefined, true)
  assert.equal(show.ok, true)
  for (const bad of [0, -1, 'x', null, 1.5, 1e20]) assert.equal((await svc.listTmdb('movie', bad)).ok, false)
})

test('listTmdb: without a key or offline it says so, and an old cached list is used when TMDB cannot be reached', async () => {
  const dir = tmp()
  assert.equal((await service(dir, { getApi: () => null }).svc.listTmdb('movie', 1)).error, 'no_api_key')
  assert.equal((await service(dir, { getApi: () => ({ get: async () => ({ ok: false, status: 503 }) }) }).svc.listTmdb('movie', 1)).error, 'offline')
  assert.equal((await service(dir, { getApi: () => ({ get: async () => ({ ok: false, status: 404 }) }) }).svc.listTmdb('movie', 1)).error, 'not_found')
  let clock = 0
  const { svc } = service(tmp(), { now: () => clock })
  await svc.listTmdb('movie', 5)
  clock += 30 * 24 * 3600 * 1000
  const { svc: down } = service(tmp(), { now: () => clock, getApi: () => ({ get: async () => ({ ok: false, status: 500 }) }) })
  assert.equal((await down.listTmdb('movie', 5)).error, 'offline', 'a different cache folder has no stale copy')
})

test('chooseTmdb: downloads only a picture TMDB listed, from image.tmdb.org, and saves a fresh JPEG', async () => {
  const dir = tmp()
  const { svc, calls } = service(dir)
  const r = await svc.chooseTmdb('movie', 603, 'poster', '/best.jpg')
  assert.equal(r.ok, true)
  assert.equal(r.art.source, 'tmdb')
  assert.equal(r.art.forTmdbId, 603)
  assert.equal(calls.find((c) => c.url).url, 'https://image.tmdb.org/t/p/w500/best.jpg')
  assert.ok(art.artworkFile(dir, r.art.file))
  assert.equal(art.imageInfo(fs.readFileSync(path.join(dir, 'artwork', r.art.file))).type, 'jpeg', 'saved as the re-encoded JPEG, not the downloaded PNG')
  const bd = await svc.chooseTmdb('movie', 603, 'backdrop', '/bd.jpg')
  assert.equal(calls.filter((c) => c.url).pop().url, 'https://image.tmdb.org/t/p/w1280/bd.jpg')
  assert.equal(bd.ok, true)
  for (const evil of ['/not-listed.jpg', '/../../etc/passwd', 'https://evil.example/x.jpg', '//evil.example/x.jpg', '/x.jpg?a=b', '']) {
    assert.equal((await svc.chooseTmdb('movie', 603, 'poster', evil)).error, 'not_listed', evil)
  }
  assert.equal((await svc.chooseTmdb('movie', 603, 'thumbnail', '/best.jpg')).error, 'bad_role')
  assert.equal(calls.filter((c) => c.url).length, 2, 'nothing else was downloaded')
})

test('chooseTmdb: a download that is not a picture (or is empty, or fails) is refused', async () => {
  const dir = tmp()
  assert.equal((await service(dir, { fetchImage: async () => Buffer.from('<html>captive portal</html>'.padEnd(64)) }).svc.chooseTmdb('movie', 1, 'poster', '/best.jpg')).error, 'bad_image')
  assert.equal((await service(dir, { fetchImage: async () => null }).svc.chooseTmdb('movie', 1, 'poster', '/best.jpg')).error, 'download_failed')
  assert.equal(fs.existsSync(path.join(dir, 'artwork')), false, 'nothing saved')
})

test('chooseFile: a real picture becomes a new JPEG; text, scripts, executables, folders and huge files are refused', async () => {
  const dir = tmp()
  const { svc } = service(dir)
  const good = path.join(dir, 'mine.png')
  fs.writeFileSync(good, png(1200, 1800))
  const r = await svc.chooseFile('poster', good)
  assert.equal(r.ok, true)
  assert.equal(r.art.source, 'upload')
  const files = { 'evil.jpg': Buffer.from('<?php system($_GET[0]); ?>'.padEnd(80)), 'page.png': Buffer.from('<script>alert(1)</script>'.padEnd(80)), 'a.exe': Buffer.from('MZ' + '\0'.repeat(100)), 'empty.jpg': Buffer.alloc(0), 'bomb.png': png(60000, 60000) }
  for (const [name, bytes] of Object.entries(files)) {
    const f = path.join(dir, name)
    fs.writeFileSync(f, bytes)
    const res = await svc.chooseFile('poster', f)
    assert.equal(res.ok, false, name)
  }
  assert.equal((await svc.chooseFile('poster', dir)).error, 'bad_path', 'a folder')
  assert.equal((await svc.chooseFile('poster', path.join(dir, 'missing.jpg'))).error, 'unreadable')
  for (const bad of ['', null, 42, 'a\0b', 'x'.repeat(5000)]) assert.equal((await svc.chooseFile('poster', bad)).ok, false)
  assert.equal((await svc.chooseFile('avatar', good)).error, 'bad_role')
})

test('chooseFile: a picture bigger than 12 MB is refused without being read into a picture', async () => {
  const dir = tmp()
  const { svc } = service(dir)
  const big = path.join(dir, 'huge.jpg')
  fs.writeFileSync(big, jpeg(500, 750, art.MAX_INPUT_BYTES + 100))
  const r = await svc.chooseFile('poster', big)
  assert.equal(r.ok, false)
  assert.match(r.message, /12 MB/)
})

function movieFolder() {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'The Matrix (1999).mkv'), '')
  fs.writeFileSync(path.join(dir, 'The Matrix (1999)-poster.jpg'), jpegWithExif(700, 1050))
  fs.writeFileSync(path.join(dir, 'The Matrix (1999)-fanart.jpg'), jpeg(1920, 1080))
  fs.mkdirSync(path.join(dir, 'Severance'))
  fs.writeFileSync(path.join(dir, 'Severance', 'poster.jpg'), jpeg(600, 900))
  fs.writeFileSync(path.join(dir, 'Severance', 'folder.png'), 'x')
  return dir
}

test('sidecar art: offered by name, imported as a fresh copy when chosen, never the original', async () => {
  const cache = tmp()
  const lib = movieFolder()
  const idx = nfo.createSidecarIndex()
  const { svc } = service(cache, { sidecars: idx, reencode: null })
  const found = svc.sidecarFor('movie', { dir: lib, fileName: 'The Matrix (1999).mkv' })
  assert.equal(path.basename(found.poster), 'The Matrix (1999)-poster.jpg')
  const r = await svc.chooseSidecar('movie', { dir: lib, fileName: 'The Matrix (1999).mkv' }, 'poster')
  assert.equal(r.ok, true)
  assert.equal(r.art.source, 'sidecar')
  assert.ok(!fs.readFileSync(path.join(cache, 'artwork', r.art.file)).includes(Buffer.from('GPS-SECRET-LOCATION')))
  assert.equal((await svc.chooseSidecar('movie', { dir: lib, fileName: 'Nothing.mkv' }, 'poster')).error, 'no_sidecar')
  const show = await svc.chooseSidecar('show', { dir: lib, showName: 'severance' }, 'poster')
  assert.equal(show.ok, true)
})

test('autoSidecar: the first ask queues an import and answers null, the next answers the prepared name; a changed picture is imported again', async () => {
  const cache = tmp()
  const lib = movieFolder()
  const { svc } = service(cache, { sidecars: nfo.createSidecarIndex(), reencode: null })
  const file = path.join(lib, 'The Matrix (1999)-poster.jpg')
  assert.equal(svc.autoSidecar('poster', file), null)
  await svc.whenImported()
  const first = svc.autoSidecar('poster', file)
  assert.match(first, /^[a-f0-9]{32}\.jpg$/)
  assert.ok(art.artworkFile(cache, first))
  fs.writeFileSync(file, jpeg(800, 1200))
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)
  assert.equal(svc.autoSidecar('poster', file), null, 'changed: not the old copy')
  await svc.whenImported()
  const second = svc.autoSidecar('poster', file)
  assert.notEqual(second, first)
  assert.equal(svc.autoSidecar('poster', path.join(lib, 'missing.jpg')), null)
  assert.ok(svc.sidecarNamesInUse().has(second))
})

test('autoSidecar: a hostile "picture" next to a film is remembered as unusable and never served', async () => {
  const cache = tmp()
  const lib = tmp()
  fs.writeFileSync(path.join(lib, 'Film-poster.jpg'), Buffer.from('<script>alert(1)</script>'.padEnd(200)))
  const { svc } = service(cache, { sidecars: nfo.createSidecarIndex() })
  const file = path.join(lib, 'Film-poster.jpg')
  assert.equal(svc.autoSidecar('poster', file), null)
  await svc.whenImported()
  assert.equal(svc.autoSidecar('poster', file), null)
  assert.deepEqual(fs.existsSync(path.join(cache, 'artwork')) ? fs.readdirSync(path.join(cache, 'artwork')).filter((n) => n.endsWith('.jpg')) : [], [])
})

const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
test('real ffmpeg: a large PNG with metadata becomes a scaled, metadata-free JPEG', { skip: ffmpeg.status !== 0 && 'ffmpeg is not installed' }, async () => {
  const dir = tmp()
  const src = path.join(dir, 'in.png')
  const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=2400x3600', '-frames:v', '1', '-metadata', 'comment=SECRET', src])
  assert.equal(made.status, 0)
  const out = await art.ffmpegReencoder(() => 'ffmpeg')(fs.readFileSync(src), { maxWidth: 1000, maxHeight: 1500 })
  const info = art.imageInfo(out)
  assert.equal(info.type, 'jpeg')
  assert.ok(info.width <= 1000 && info.height <= 1500 && info.width >= 900, `${info.width}x${info.height}`)
  assert.ok(!out.includes(Buffer.from('SECRET')))
  assert.equal(await art.ffmpegReencoder(() => 'ffmpeg')(Buffer.from('this is not an image'.repeat(10)), { maxWidth: 10, maxHeight: 10 }), null)
  assert.equal(await art.ffmpegReencoder(() => null)(fs.readFileSync(src), { maxWidth: 10, maxHeight: 10 }), null)
  assert.equal(await art.ffmpegReencoder(() => path.join(dir, 'no-such-ffmpeg'))(fs.readFileSync(src), { maxWidth: 10, maxHeight: 10 }), null)
})
