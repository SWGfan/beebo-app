'use strict'
// The automatic work that runs without anyone asking holds back while someone is watching, the PC is on battery or
// busy (backgroundGate.js): music rescans and the intro scanner here; conversions and sweeps use the same gate.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const musicLibrary = require('../electron/musicLibrary')
const { createIntroScanner } = require('../electron/introDetectJob')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function musicFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-music-defer-'))
  fs.mkdirSync(path.join(root, 'Artist', 'Album'), { recursive: true })
  for (const n of ['01 - A.mp3', '02 - B.mp3']) fs.writeFileSync(path.join(root, 'Artist', 'Album', n), 'x')
  return root
}
const tags = async (file) => ({ title: path.basename(file, '.mp3'), artist: 'Artist', album: 'Album', duration: 10 })

test('a timer-driven music rescan waits while the gate says so, but the first scan of an empty library and a manual scan do not', async () => {
  const root = musicFolder()
  let defer = true
  const cache = path.join(root, '..', 'beebo-music-cache-' + process.pid)
  const lib = musicLibrary.createMusicLibrary({ getDirs: () => [root], getCacheDir: () => cache, readTags: tags, shouldDefer: () => defer })
  try {
    lib.scheduleScan(10)
    await sleep(400)
    assert.equal(lib.status().trackCount, 2, 'an empty library is scanned even while the gate is closed')
    const first = lib.status().lastScanAt
    fs.writeFileSync(path.join(root, 'Artist', 'Album', '03 - C.mp3'), 'x')
    lib.scheduleScan(10)
    await sleep(400)
    assert.equal(lib.status().trackCount, 2, 'held back: the new file is not looked for yet')
    assert.equal(lib.status().lastScanAt, first)
    await lib.scan()
    assert.equal(lib.status().trackCount, 3, 'the Rescan button always works')
  } finally { lib.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }) }
})

test('the intro scanner reports why it is waiting: playback, battery or busy', async () => {
  for (const reason of ['playback', 'battery', 'busy']) {
    let busy = reason
    const data = {}
    const s = createIntroScanner({
      store: { get: (k) => data[k], set: (k, v) => { data[k] = v } },
      listItems: () => [{ kind: 'movie', id: 'm', path: 'D:\\m.mp4', label: 'm' }],
      isBusy: () => busy,
      ffmpegPath: () => 'ffmpeg', ffprobePath: () => 'ffprobe', cacheDir: () => null,
      statFile: () => ({ size: 1, mtimeMs: 1 }),
      probe: async () => 1500, analyseTail: async () => ({ ok: true, black: [], silence: [] }),
      sleep: (ms) => sleep(Math.min(ms, 5)), pauseBetweenMs: 0, pollMs: 5,
      settings: { enabled: () => true, concurrency: () => 1, fullDecode: () => false },
      timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} }
    })
    const pass = s.runPass()
    await sleep(60)
    assert.equal(s.status().paused, reason)
    busy = false
    const r = await pass
    assert.equal(r.ok, true)
    assert.equal(s.status().paused, null)
    assert.equal(s.status().itemsDone, 1)
  }
})
