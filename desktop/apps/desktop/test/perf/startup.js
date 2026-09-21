#!/usr/bin/env node
'use strict'
// Start-up cost of loading the stream server module in a fresh Node process (docs/PERFORMANCE.md):
//   node test/perf/startup.js [--runs 9]
// Prints the median and range of `require('../../electron/streamServer.js')` in milliseconds and the RSS afterwards.
// (The real app also loads main.js and Electron; this is the part of start-up that is ours.)
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const args = process.argv.slice(2)
const runs = Number((args.indexOf('--runs') >= 0 && args[args.indexOf('--runs') + 1]) || 9)
const target = path.join(__dirname, '..', '..', 'electron', 'streamServer.js')
const code = `const t=process.hrtime.bigint();require(${JSON.stringify(target)});const ms=Number(process.hrtime.bigint()-t)/1e6;console.log(JSON.stringify({ms,rssMB:process.memoryUsage().rss/1048576,heapMB:process.memoryUsage().heapUsed/1048576}))`
const ms = []
const rss = []
for (let i = 0; i < runs + 1; i++) {
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stderr); process.exit(1) }
  if (i === 0) continue // the first run only warms the OS file cache
  const j = JSON.parse(r.stdout.trim().split('\n').pop())
  ms.push(j.ms); rss.push(j.rssMB)
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]
const r1 = (x) => Math.round(x * 10) / 10
console.log(JSON.stringify({ runs, requireMedianMs: r1(med(ms)), requireMinMs: r1(Math.min(...ms)), requireMaxMs: r1(Math.max(...ms)), rssMedianMB: r1(med(rss)) }))
