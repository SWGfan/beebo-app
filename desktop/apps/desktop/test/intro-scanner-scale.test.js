'use strict'
// The intro/credits scanner on a big library: a pass is not quadratic in the number of files, the results live in
// their own file (not in config.json), old results are moved over safely, and the progress figure is exact at the end.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createIntroScanner, STORE_KEY } = require('../electron/introDetectJob')

function tvItems(n, perShow = 30) {
  return Array.from({ length: n }, (_, i) => {
    const show = Math.floor(i / perShow)
    const season = 1 + Math.floor((i % perShow) / 10)
    const ep = 1 + (i % 10)
    return { kind: 'tv', id: 'id' + i, path: `D:\\TV\\S${show}\\Season ${season}\\S${show} - S0${season}E${ep}.mp4`, showKey: 'show' + show, showName: 'Show ' + show, season, episode: ep, label: 'x' + i }
  })
}

function scanner(list, extra = {}) {
  const data = extra.data || {}
  const store = extra.store || { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  const s = createIntroScanner({
    store,
    listItems: () => list,
    ffmpegPath: () => 'ffmpeg', ffprobePath: () => 'ffprobe', cacheDir: () => null,
    statFile: () => ({ size: 1000, mtimeMs: 1 }),
    probe: async () => 1500,
    extract: async () => ({ ok: true, fp: new Uint32Array(8) }),
    analyseTail: async () => ({ ok: true, black: [], silence: [] }),
    detectSeason: async () => new Map(),
    sleep: () => Promise.resolve(), pauseBetweenMs: 0,
    settings: { enabled: () => true, concurrency: () => 1, fullDecode: () => false },
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} },
    ...(extra.opts || {})
  })
  return { s, store, data }
}

test('a pass over 4,000 files costs milliseconds of bookkeeping, not seconds (it used to grow with the square of the library)', async () => {
  const { s } = scanner(tvItems(4000))
  const t0 = Date.now()
  const r = await s.runPass()
  const ms = Date.now() - t0
  assert.equal(r.ok, true)
  assert.ok(ms < 3000, `4,000 entries took ${ms} ms`)
  assert.equal(s.status().itemsTotal, 4000)
  assert.equal(s.status().itemsDone, 4000, 'the final count is exact even though it is only refreshed now and then during a pass')
})

test('records live in their own file next to the settings, not in the settings store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-scan-'))
  const data = {}
  const store = { path: path.join(dir, 'config.json'), get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  const { s } = scanner(tvItems(60), { store })
  await s.runPass()
  s.flush()
  const file = path.join(dir, 'auto-markers.json')
  assert.ok(fs.existsSync(file), 'auto-markers.json written')
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(Object.keys(onDisk).length >= 60, 'one record per file: ' + Object.keys(onDisk).length)
  assert.equal(data[STORE_KEY], undefined, 'nothing under the settings key any more')
  assert.equal(s.status().itemsTotal, 60)
  // A second scanner (a restart) finds the records and has nothing left to do.
  const again = scanner(tvItems(60), { store })
  assert.ok(Object.keys(again.s._records()).length >= 60)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('results an older build kept in the settings are moved over once, and only removed after the file is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-scan-mig-'))
  const old = { 'D:\\a.mp4|1|1': { identity: 'D:\\a.mp4|1|1', kind: 'movie', version: 1, creditsDone: true } }
  const data = { [STORE_KEY]: old }
  const store = { path: path.join(dir, 'config.json'), get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  const { s } = scanner([], { store })
  assert.deepEqual(s._records(), old)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auto-markers.json'), 'utf8')), old)
  assert.equal(data[STORE_KEY], undefined, 'gone from config.json')

  // If the new file cannot be written the settings copy is left alone.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-scan-mig2-'))
  const data2 = { [STORE_KEY]: old }
  const blocked = path.join(dir2, 'config.json')
  const store2 = { path: blocked, get: (k) => data2[k], set: (k, v) => { data2[k] = v }, delete: (k) => { delete data2[k] } }
  fs.mkdirSync(path.join(dir2, 'auto-markers.json')) // a folder where the file should go
  const b = scanner([], { store: store2 })
  assert.deepEqual(b.s._records(), old, 'still usable in memory')
  assert.deepEqual(data2[STORE_KEY], old, 'and still in the settings')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(dir2, { recursive: true, force: true })
})

test('a store without a file path behaves exactly as before (records under the settings key)', async () => {
  const { s, data } = scanner(tvItems(30))
  await s.runPass()
  s.flush()
  assert.ok(data[STORE_KEY] && Object.keys(data[STORE_KEY]).length >= 30)
})
