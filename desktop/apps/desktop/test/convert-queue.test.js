const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

// The converter resolves ffmpeg when it is first required. The last test needs a real one; point
// BEEBO_FFMPEG/BEEBO_FFPROBE at it (or keep one in resources/ffmpeg) or that test is skipped.
const convert = localRequire('./electron/convert')

function fakeStore(initial = {}) {
  const m = new Map(Object.entries(initial))
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }
}
const SEP_2026 = Date.UTC(2026, 8, 1)
const entry = (id, over = {}) => ({
  id: `${SEP_2026 + id}-abc123`,
  originalPath: path.resolve(`/lib/ep${id}.mkv`),
  outputPath: path.resolve(`/lib/ep${id}.mp4`),
  status: 'queued',
  kind: 'tv',
  castAvailable: false,
  queuedAt: SEP_2026 + id,
  ...over
})

test('Convert whole show moves episodes to the front without touching their queued date', () => {
  const store = fakeStore({ conversions: [entry(1), entry(2), entry(3), entry(4)] })
  const moved = convert.prioritize(store, [path.resolve('/lib/ep4.mkv'), path.resolve('/lib/ep3.mkv')])
  assert.equal(moved, 2)
  const all = store.get('conversions')
  assert.deepEqual(all.map((e) => e.queuedAt), [1, 2, 3, 4].map((i) => SEP_2026 + i))
  assert.equal(convert.pickNext(all).originalPath, path.resolve('/lib/ep4.mkv'))
  // ...then ep3, then the rest of the library in the order it was queued.
  const order = []
  let list = all
  for (let n = 0; n < 4; n++) {
    const next = convert.pickNext(list)
    order.push(path.basename(next.originalPath))
    list = list.map((e) => (e.id === next.id ? { ...e, status: 'done' } : e))
  }
  assert.deepEqual(order, ['ep4.mkv', 'ep3.mkv', 'ep1.mkv', 'ep2.mkv'])
  for (const e of convert.list(store)) assert.ok(new Date(e.queuedAt).getUTCFullYear() >= 2026)
})

test('a show asked for earlier stays ahead of one asked for later', async () => {
  const store = fakeStore({ conversions: [entry(1), entry(2)] })
  convert.prioritize(store, [path.resolve('/lib/ep2.mkv')])
  await new Promise((r) => setTimeout(r, 5))
  convert.prioritize(store, [path.resolve('/lib/ep1.mkv')])
  assert.equal(path.basename(convert.pickNext(store.get('conversions')).originalPath), 'ep2.mkv')
})

test('entries damaged by the old whole-show code show a real date but keep their place', () => {
  const store = fakeStore({
    conversions: [entry(1), entry(7, { queuedAt: 2 }), entry(8, { queuedAt: 1 }), entry(9, { queuedAt: null, id: 'not-a-time' })]
  })
  const shown = convert.list(store)
  const byName = Object.fromEntries(shown.map((e) => [path.basename(e.originalPath), e.queuedAt]))
  assert.equal(byName['ep7.mkv'], SEP_2026 + 7)
  assert.equal(byName['ep8.mkv'], SEP_2026 + 8)
  assert.equal(byName['ep9.mkv'], null)
  // The store itself is not rewritten, and the queue order the owner asked for survives.
  assert.equal(store.get('conversions')[1].queuedAt, 2)
  assert.equal(path.basename(convert.pickNext(store.get('conversions')).originalPath), 'ep8.mkv')
})

test('Convert again clears the front-of-queue place', () => {
  const store = fakeStore({ conversions: [entry(1, { status: 'error', frontOfQueueAt: 5, frontOfQueueSeq: 0 }), entry(2)] })
  convert.retry(store, `${SEP_2026 + 1}-abc123`)
  assert.equal(path.basename(convert.pickNext(store.get('conversions')).originalPath), 'ep2.mkv')
})

function findFf(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name
  const c = [process.env['BEEBO_' + name.toUpperCase()], path.join(appRoot, 'resources', 'ffmpeg', exe)]
  return c.find((p) => p && fs.existsSync(p)) || null
}

test('a converted file keeps the original file date', { skip: !(findFf('ffmpeg') && findFf('ffprobe')) && 'no ffmpeg/ffprobe available' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-convert-'))
  try {
    const src = path.join(dir, 'Show S01E01.mkv')
    // h264 + DTS in MKV: the converter copies the video and re-encodes the audio. (AC-3 used to be
    // the example, but AC-3 plays as it is under playbackRules, so it is no longer converted.)
    execFileSync(findFf('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000',
      '-c:v', 'libopenh264', '-c:a', 'dca', '-strict', '-2', '-ac', '2', src], { windowsHide: true })
    const old = new Date(Date.UTC(2015, 5, 15, 12, 0, 0))
    fs.utimesSync(src, old, old)
    const store = fakeStore({ conversions: [] })
    convert.ensureWorker(store, () => {})
    convert.enqueue(store, { path: src, kind: 'tv', castAvailable: false })
    let done = null
    for (let i = 0; i < 300 && !done; i++) {
      await new Promise((r) => setTimeout(r, 100))
      done = store.get('conversions').find((e) => e.status !== 'queued' && e.status !== 'converting')
    }
    assert.ok(done, 'conversion did not finish')
    assert.equal(done.status, 'done', String(done.error))
    assert.equal(Math.round(fs.statSync(done.outputPath).mtimeMs / 1000), Math.round(old.getTime() / 1000))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
