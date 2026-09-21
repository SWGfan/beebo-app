#!/usr/bin/env node
'use strict'
// Before/after table from two bench-server.js --json outputs (docs/PERFORMANCE.md).
//   node test/perf/compare.js before.json after.json
const fs = require('node:fs')
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
const pad = (s, n) => String(s).padEnd(n)
const num = (x) => (typeof x === 'number' ? x : '-')
console.log('| route | bytes | p50 before | p50 after | p95 before | p95 after | store.get/req before | after |')
console.log('|---|---:|---:|---:|---:|---:|---:|---:|')
for (const k of Object.keys(a.routes)) {
  const x = a.routes[k]
  const y = (b.routes || {})[k] || {}
  console.log(`| ${k} | ${num(y.bytes || x.bytes)} | ${num(x.p50)} | ${num(y.p50)} | ${num(x.p95)} | ${num(y.p95)} | ${num(x.storeGetsPerRequest)} | ${num(y.storeGetsPerRequest)} |`)
}
const row = (label, f) => console.log(`| ${pad(label, 28)} | ${num(f(a))} | ${num(f(b))} |`)
console.log('\n| metric | before | after |\n|---|---:|---:|')
row('boot to listening (ms)', (r) => r.bootToListeningMs)
row('require streamServer (ms)', (r) => r.requireMs)
row('RSS after load (MB)', (r) => r.memory && r.memory.rssMB)
row('heap used after GC (MB)', (r) => r.memory && r.memory.heapUsedMB)
row('idle CPU (% of one core)', (r) => r.idle && r.idle.cpuPercentOfOneCore)
row('idle event-loop p99 (ms)', (r) => r.idle && r.idle.eventLoopP99Ms)
row('store.get calls (whole run)', (r) => r.storeGets && r.storeGets.total)
row('store.get total ms', (r) => r.storeGets && r.storeGets.totalMs)
row('store.get ms per call', (r) => r.storeGets && r.storeGets.perCallMs)
row('store.set total ms', (r) => r.storeSets && r.storeSets.totalMs)
