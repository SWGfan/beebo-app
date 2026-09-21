#!/usr/bin/env node
'use strict'
// Micro-benchmarks for docs/PERFORMANCE.md: the pieces that do not need a whole server.
//   node test/perf/bench-micro.js [--json out.json] [--reps 5]
// Every number is the median of --reps runs of the same operation (each run itself averages
// many iterations), on the real files of a temp folder. Includes:
//   - store.get on a real conf/electron-store file of 20 KB / 200 KB / 1 MB (plus the secrets wrapper)
//   - the TMDB manifest write (tmdbCache.writeJson: pretty JSON + fsync + rename) at 1k/2k/5k titles,
//     and what compact JSON would cost, and a cold parse
//   - the HLS segment prune (readdirSync per segment request) for a 60 and a 2,000 file session folder
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP = path.join(__dirname, '..', '..')
const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const reps = Number(argOf('reps', 5))
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] }
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d
const hr = () => Number(process.hrtime.bigint()) / 1e6

function time(iterations, fn) {
  const out = []
  for (let r = 0; r < reps; r++) {
    const t = hr()
    for (let i = 0; i < iterations; i++) fn(i)
    out.push((hr() - t) / iterations)
  }
  return round(median(out))
}

const result = { reps, node: process.version, platform: process.platform + ' ' + os.release(), cpu: os.cpus()[0].model, cores: os.cpus().length }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-micro-'))

// ---- store.get ----------------------------------------------------------------------------------
{
  const Conf = require('conf')
  const { createSecretSettings, APP_SECRET_KEYS } = require('../../electron/secretSettings')
  let cache = null
  try { cache = require('../../electron/storeCache') } catch { /* not built yet (before the fix) */ }
  result.storeGet = {}
  for (const [label, entries] of [['20KB', 20], ['200KB', 220], ['1MB', 1100]]) {
    const dir = fs.mkdtempSync(path.join(tmp, 'ud-'))
    const c = new Conf({ cwd: dir, configName: 'config' })
    const queue = {}
    for (let i = 0; i < entries; i++) queue['review-' + i] = { name: 'Some Show ' + i + ' S01E01.mp4', candidates: Array.from({ length: 3 }, (_, k) => ({ id: i * 10 + k, title: 'Candidate ' + k, overview: 'y'.repeat(120) })) }
    c.set('titleReviewQueue', queue)
    c.set('streamPort', 45000)
    c.set('authUsers', Array.from({ length: 7 }, (_, i) => ({ id: 'u' + i, name: 'User ' + i, username: 'user' + i, status: 'approved' })))
    const bytes = fs.statSync(c.path).size
    const fake = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(String(s)).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() }
    createSecretSettings({ store: c, safeStorage: fake, keys: APP_SECRET_KEYS, log: () => {} }).install()
    c.set('sessionSecret', 'a'.repeat(64))
    const row = { bytes, plainKeyMs: time(200, () => c.get('streamPort')), secretKeyMs: time(200, () => c.get('sessionSecret')), authUsersMs: time(200, () => c.get('authUsers')), setMs: time(20, (i) => c.set('counterKey', i)) }
    if (cache && cache.cacheStoreReads) {
      cache.cacheStoreReads(c)
      row.cachedPlainKeyMs = time(2000, () => c.get('streamPort'))
      row.cachedSecretKeyMs = time(2000, () => c.get('sessionSecret'))
      row.cachedAuthUsersMs = time(2000, () => c.get('authUsers'))
      row.cachedSetMs = time(20, (i) => c.set('counterKey', i))
    }
    result.storeGet[label] = row
  }
}

// ---- TMDB manifest write/read ----------------------------------------------------------------------
{
  const tmdbCache = require('../../electron/tmdbCache')
  result.tmdbManifest = {}
  for (const n of [1000, 2000, 5000]) {
    const dir = fs.mkdtempSync(path.join(tmp, 'tmdb-'))
    const manifest = {}
    for (let i = 0; i < n; i++) manifest[`Some Movie Title ${i} (${1950 + (i % 70)}).mp4`] = { id: 100000 + i, title: 'Some Movie Title ' + i, release_date: '1999-01-01', poster_path: '/p' + i + '.jpg', backdrop_path: '/b' + i + '.jpg', genre_ids: [28, 12], overview: 'A reluctant hero is pulled back into a world she thought she had left behind. '.repeat(3), vote_average: 7.1, certification: 'PG-13' }
    const file = path.join(dir, 'manifest.json')
    tmdbCache.writeJson(file, manifest)
    const pretty = JSON.stringify(manifest, null, 2).length
    const compact = JSON.stringify(manifest).length
    const row = {
      prettyBytes: pretty, compactBytes: compact,
      writeJsonMs: time(10, (i) => { manifest['Some Movie Title 0 (1950).mp4'].vote_average = i; tmdbCache.writeJson(file, manifest) }),
      stringifyPrettyMs: time(10, () => JSON.stringify(manifest, null, 2)),
      stringifyCompactMs: time(10, () => JSON.stringify(manifest)),
      parseMs: time(10, () => JSON.parse(fs.readFileSync(file, 'utf8')))
    }
    // The same write with the durable-but-slow parts separated: fsync + rename cost of a file this size.
    row.fsyncRenameMs = time(10, () => { const fd = fs.openSync(file + '.x', 'w'); fs.writeSync(fd, 'x'.repeat(compact)); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(file + '.x', file + '.y') })
    result.tmdbManifest[n + ' titles'] = row
  }
}

// ---- HLS prune -------------------------------------------------------------------------------------
{
  result.hlsPrune = {}
  for (const n of [60, 2000]) {
    const dir = fs.mkdtempSync(path.join(tmp, 'hls-'))
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `seg-${String(i).padStart(5, '0')}.ts`), '')
    fs.writeFileSync(path.join(dir, 'index.m3u8'), '')
    const keepBehind = 30
    // The exact body of hlsTranscoder prune(s, n), on a copy of the folder each call so every call deletes the same amount.
    const prune = (n2) => {
      let names = []
      try { names = fs.readdirSync(dir) } catch { return }
      for (const name of names) {
        const m = /^seg-(\d+)\.ts$/.exec(name)
        if (!m) continue
        const i = Number(m[1])
        if (i < n2 - keepBehind) { try { fs.unlinkSync(path.join(dir, name)) } catch {} }
      }
    }
    prune(n) // first call deletes what is behind; later calls (the steady state) only list the folder
    result.hlsPrune[n + ' files'] = { steadyStateMs: time(200, () => prune(n)) }
  }
}

// ---- photo EXIF read (first scan of a big photo library) ---------------------------------------------
{
  const exif = require('../../electron/photoExif')
  const { jpegWithExif } = require('./gen-synthetic-library')
  const base = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
  const dir = fs.mkdtempSync(path.join(tmp, 'photos-'))
  const N = 200
  const files = []
  for (let i = 0; i < N; i++) {
    const f = path.join(dir, `IMG_${i}.jpg`)
    fs.writeFileSync(f, Buffer.concat([jpegWithExif(base, { date: '2021:06:05 14:30:15', make: 'Canon', model: 'EOS R6' }), Buffer.alloc(3 * 1024 * 1024, i & 255)]))
    files.push(f)
  }
  const stats = files.map((f) => fs.statSync(f))
  const one = async () => { const t = hr(); for (let i = 0; i < N; i++) await exif.readMediaInfo(files[i], stats[i]); return (hr() - t) / N }
  const per = []
  ;(async () => {
    for (let r = 0; r < reps; r++) per.push(await one())
    result.photoExif = { photos: N, photoBytes: stats[0].size, perPhotoMs: round(median(per)), note: 'readMediaInfo over 3 MB JPEGs, OS file cache warm' }
    finish()
  })()
}

function finish() {
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* temp */ }
const text = JSON.stringify(result, null, 2)
const jsonOut = argOf('json', '')
if (jsonOut) fs.writeFileSync(jsonOut, text)
console.log(text)
}
