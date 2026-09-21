const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

const scan = localRequire('./electron/playabilityScan')
// The real verdict. Required here only for isBrowserPlayable; the last test also
// needs a real ffprobe (BEEBO_FFPROBE / BEEBO_FFMPEG, or resources/ffmpeg) or it is skipped.
const convert = localRequire('./electron/convert')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The loop the admin route used to run, verbatim apart from the probe being passed in.
async function oldLoop(files, probe) {
  const needs = []
  for (const f of files) {
    let n = false
    try {
      const ext = path.extname(f.path).toLowerCase()
      const pr = await probe(f.path)
      n = !convert.isBrowserPlayable(pr, ext)
    } catch { n = false }
    if (n) needs.push(f.path)
  }
  return needs
}

async function runScan(scanner, files) {
  const needs = []
  const r = scanner.start({ listFiles: async () => files, onNeeds: (f) => { needs.push(f.path); return true } })
  await r.done
  return { needs, status: scanner.status() }
}

test('runPool never runs more than the limit at once and runs everything', async () => {
  let live = 0, peak = 0
  const seen = []
  const items = Array.from({ length: 40 }, (_, i) => i)
  const started = await scan.runPool(items, 4, async (x) => {
    live++; peak = Math.max(peak, live)
    await sleep(2 + (x % 5))
    seen.push(x)
    live--
  })
  assert.equal(started, 40)
  assert.equal(peak, 4)
  assert.deepEqual(seen.slice().sort((a, b) => a - b), items)
})

test('the scanner pool is bounded by its concurrency', async () => {
  let live = 0, peak = 0
  const probe = async () => { live++; peak = Math.max(peak, live); await sleep(5); live--; return { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true } }
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `/lib/f${i}.mp4`, kind: 'movie' }))
  const s = scan.createUnplayableScanner({ probe, isBrowserPlayable: convert.isBrowserPlayable, concurrency: 3, stat: async () => ({ size: 1, mtimeMs: 1 }) })
  const { status } = await runScan(s, files)
  assert.equal(peak, 3)
  assert.equal(status.state, 'done')
  assert.equal(status.checked, 30)
  assert.ok(scan.defaultConcurrency() >= 2)
})

test('cache: unchanged files are not probed again; a changed size or mtime is; failed probes are not cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-scan-cache-'))
  try {
    const cacheFile = path.join(dir, 'cache.json')
    const stats = { '/lib/a.mp4': { size: 10, mtimeMs: 100 }, '/lib/b.mp4': { size: 20, mtimeMs: 200 }, '/lib/c.mp4': { size: 30, mtimeMs: 300 } }
    const probed = []
    const probe = async (p) => { probed.push(p); return p.endsWith('c.mp4') ? null : { videoCodec: 'h264', audioCodec: p.endsWith('b.mp4') ? 'ac3' : 'aac', hasAudio: true } }
    const files = Object.keys(stats).map((p) => ({ path: p, kind: 'movie' }))
    const mk = () => scan.createUnplayableScanner({ probe, isBrowserPlayable: convert.isBrowserPlayable, cache: scan.createProbeCache({ file: cacheFile }), stat: async (p) => ({ ...stats[p] }) })

    let r = await runScan(mk(), files)
    assert.deepEqual(probed.sort(), ['/lib/a.mp4', '/lib/b.mp4', '/lib/c.mp4'])
    assert.deepEqual(r.needs, ['/lib/b.mp4', '/lib/c.mp4'])
    assert.ok(fs.existsSync(cacheFile), 'cache persisted')

    // A new scanner (as after a restart) reads the cache from disk.
    probed.length = 0
    r = await runScan(mk(), files)
    assert.deepEqual(probed, ['/lib/c.mp4'], 'only the failed probe is retried')
    assert.equal(r.status.fromCache, 2)
    assert.deepEqual(r.needs, ['/lib/b.mp4', '/lib/c.mp4'])

    // Replace a.mp4 with a different file of the same name: new mtime, then new size.
    stats['/lib/a.mp4'].mtimeMs = 101
    probed.length = 0
    await runScan(mk(), files)
    assert.deepEqual(probed.sort(), ['/lib/a.mp4', '/lib/c.mp4'])
    stats['/lib/b.mp4'].size = 21
    probed.length = 0
    await runScan(mk(), files)
    assert.deepEqual(probed.sort(), ['/lib/b.mp4', '/lib/c.mp4'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('extensions that can never play are decided without a probe', async () => {
  const probed = []
  const probe = async (p) => { probed.push(p); return { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true } }
  const files = ['/l/a.mkv', '/l/b.avi', '/l/c.mp4', '/l/d.webm', '/l/e.MOV', '/l/f'].map((p) => ({ path: p, kind: 'movie' }))
  const s = scan.createUnplayableScanner({ probe, isBrowserPlayable: convert.isBrowserPlayable, stat: async () => ({ size: 1, mtimeMs: 1 }) })
  const r = await runScan(s, files)
  assert.deepEqual(probed.sort(), ['/l/c.mp4', '/l/d.webm', '/l/e.MOV'])
  assert.deepEqual(r.needs, await oldLoop(files, probe))
  assert.equal(r.status.skippedByExtension, 3)
})

test('identical results and queue order to the old loop, even when probes finish out of order', async () => {
  const kinds = [
    { videoCodec: 'h264', audioCodec: 'aac', hasAudio: true },
    { videoCodec: 'h264', audioCodec: 'ac3', hasAudio: true },
    { videoCodec: 'hevc', audioCodec: 'aac', hasAudio: true },
    { videoCodec: 'vp9', audioCodec: 'opus', hasAudio: true },
    { videoCodec: 'h264', audioCodec: null, hasAudio: false },
    null
  ]
  const exts = ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.ts']
  const files = Array.from({ length: 120 }, (_, i) => ({ path: `/lib/x${i}${exts[(i * 7) % exts.length]}`, kind: i % 2 ? 'tv' : 'movie' }))
  const verdictOf = (p) => kinds[Number(p.match(/x(\d+)/)[1]) % kinds.length]
  const slowProbe = async (p) => { await sleep((Number(p.match(/x(\d+)/)[1]) * 13) % 9); return verdictOf(p) }
  const expected = await oldLoop(files, async (p) => verdictOf(p))
  // A missing file: stat throws, the probe fails (null) — the old loop flagged such an mp4, so must we.
  const s = scan.createUnplayableScanner({ probe: slowProbe, isBrowserPlayable: convert.isBrowserPlayable, concurrency: 8, stat: async (p) => { if (p.endsWith('x6.mp4')) throw new Error('ENOENT'); return { size: 1, mtimeMs: 1 } } })
  const r = await runScan(s, files)
  assert.deepEqual(r.needs, expected)
  assert.equal(r.status.needsConversion, expected.length)
  assert.equal(r.status.enqueued, expected.length)
  // And a warm rescan says the same.
  const r2 = await runScan(s, files)
  assert.deepEqual(r2.needs, expected)
})

test('cancel stops new probes, kills the ones running, and queues only what was decided', async () => {
  const aborted = []
  let started = 0
  const probe = (p, { signal } = {}) => new Promise((resolve) => {
    started++
    const onAbort = () => { clearTimeout(t); aborted.push(p); resolve(null) }
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve({ videoCodec: 'hevc', hasAudio: false }) }, p.endsWith('0.mp4') ? 5 : 10000)
    signal.addEventListener('abort', onAbort)
  })
  const files = Array.from({ length: 50 }, (_, i) => ({ path: `/lib/f${i}.mp4`, kind: 'movie' }))
  const needs = []
  const s = scan.createUnplayableScanner({ probe, isBrowserPlayable: convert.isBrowserPlayable, concurrency: 4, stat: async () => ({ size: 1, mtimeMs: 1 }) })
  const r = s.start({ listFiles: async () => files, onNeeds: (f) => { needs.push(f.path); return true } })
  assert.equal(r.started, true)
  assert.equal(s.start({ listFiles: async () => files }).started, false, 'a second scan does not start while one runs')
  await sleep(100)
  assert.equal(s.status().state, 'scanning')
  const c = s.cancel()
  assert.equal(c.cancelled, true)
  await r.done
  const st = s.status()
  assert.equal(st.state, 'cancelled')
  assert.ok(started < 50, 'did not probe the whole library')
  assert.ok(aborted.length >= 1, 'in-flight probes were aborted')
  // Aborted probes resolve null, which would read as "cannot play" — they must not be queued.
  for (const p of aborted) assert.ok(!needs.includes(p))
  assert.equal(st.enqueued, needs.length)
  assert.equal(s.cancel().cancelled, false, 'nothing left to cancel')
})

test('real ffprobe: the pooled scan agrees with the old loop on generated videos', async (t) => {
  const ffmpeg = process.env.BEEBO_FFMPEG
  if (!ffmpeg || !fs.existsSync(ffmpeg) || !process.env.BEEBO_FFPROBE) { t.skip('set BEEBO_FFMPEG and BEEBO_FFPROBE to run'); return }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-scan-real-'))
  try {
    const V = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1']
    const A = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']
    const specs = [
      ['a.mp4', [...V, ...A, '-c:v', 'libopenh264', '-c:a', 'aac']],
      ['b.mp4', [...V, ...A, '-c:v', 'libopenh264', '-c:a', 'ac3']],
      ['c.mp4', [...V, ...A, '-c:v', 'mpeg4', '-c:a', 'aac']],
      ['d.mkv', [...V, ...A, '-c:v', 'libopenh264', '-c:a', 'aac']],
      ['e.m4v', [...V, '-c:v', 'libopenh264']],
      ['f.mp4', null]
    ]
    for (const [name, args] of specs) {
      if (args) execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(dir, name)])
      else fs.writeFileSync(path.join(dir, name), 'not a video')
    }
    const files = specs.map(([name]) => ({ path: path.join(dir, name), kind: 'movie' }))
    const expected = await oldLoop(files, convert.probeStreams)
    const s = scan.createUnplayableScanner({ probe: convert.probeStreams, isBrowserPlayable: convert.isBrowserPlayable, cache: scan.createProbeCache({ file: path.join(dir, 'c.json') }) })
    const r = await runScan(s, files)
    assert.deepEqual(r.needs, expected)
    assert.deepEqual(expected.map((p) => path.basename(p)), ['b.mp4', 'c.mp4', 'd.mkv', 'f.mp4'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
