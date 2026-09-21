#!/usr/bin/env node
'use strict'
// The automatic intro/credits scanner's own bookkeeping on a big library (docs/PERFORMANCE.md): every ffmpeg/ffprobe
// call is replaced by an instant fake, so what is timed is the JS around them: listing and stat-ing every file,
// grouping, the progress count after each item, saving records. Reports the whole pass, and the longest stretch the
// event loop was blocked (what a viewer's stream would feel).
//   node test/perf/bench-scanner.js [--sizes 2000,5000,10000] [--json out.json]
const { monitorEventLoopDelay } = require('node:perf_hooks')
const path = require('node:path')
const { createIntroScanner } = require('../../electron/introDetectJob')

const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const sizes = String(argOf('sizes', '2000,5000,10000')).split(',').map(Number)
const jsonOut = argOf('json', '')

function items(n) {
  const out = []
  const perShow = 30
  for (let i = 0; i < n; i++) {
    const show = Math.floor(i / perShow)
    const season = 1 + Math.floor((i % perShow) / 10)
    const ep = 1 + (i % 10)
    out.push({ kind: 'tv', id: 'id' + i, path: `D:\\TV\\Show ${show}\\Season ${season}\\Show ${show} - S0${season}E${String(ep).padStart(2, '0')}.mp4`, showKey: 'show' + show, showName: 'Show ' + show, season, episode: ep, label: 'Show ' + show + '/' + i })
  }
  return out
}

async function once(n) {
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  const list = items(n)
  const scanner = createIntroScanner({
    store,
    listItems: () => list,
    ffmpegPath: () => 'ffmpeg', ffprobePath: () => 'ffprobe', cacheDir: () => null,
    statFile: () => ({ size: 1000, mtimeMs: 1 }),
    probe: async () => 1500,
    extract: async () => ({ ok: true, fp: new Uint32Array(8) }),
    analyseTail: async () => ({ ok: true, black: [], silence: [] }),
    detectSeason: async () => new Map(),
    sleep: () => Promise.resolve(),
    pauseBetweenMs: 0,
    settings: { enabled: () => true, concurrency: () => 1, fullDecode: () => false },
    timers: { setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {} }
  })
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const t0 = process.hrtime.bigint()
  const r = await scanner.runPass()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  h.disable()
  return { entries: n, passMs: Math.round(ms), processed: r && r.processed, loopMaxBlockMs: Math.round(h.max / 1e6), loopP99Ms: Math.round(h.percentile(99) / 1e6) }
}

;(async () => {
  const rows = []
  for (const n of sizes) { rows.push(await once(n)); console.error(JSON.stringify(rows[rows.length - 1])) }
  const out = { node: process.version, rows }
  if (jsonOut) require('node:fs').writeFileSync(jsonOut, JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
})()
void path
