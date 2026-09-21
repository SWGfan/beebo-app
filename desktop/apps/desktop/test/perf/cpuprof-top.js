#!/usr/bin/env node
'use strict'
// Top self-time functions of a V8 .cpuprofile (node --cpu-prof), for docs/PERFORMANCE.md.
//   node test/perf/cpuprof-top.js file.cpuprofile [--n 25]
const fs = require('node:fs')
const path = require('node:path')
const file = process.argv[2]
const n = Number((process.argv.indexOf('--n') > 0 && process.argv[process.argv.indexOf('--n') + 1]) || 25)
const prof = JSON.parse(fs.readFileSync(file, 'utf8'))
const byId = new Map(prof.nodes.map((nd) => [nd.id, nd]))
const self = new Map()
const dt = prof.timeDeltas
for (let i = 0; i < prof.samples.length; i++) self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + (dt[i] || 0))
const rows = new Map()
let total = 0
for (const [id, us] of self) {
  const cf = byId.get(id).callFrame
  const key = `${cf.functionName || '(anonymous)'} ${path.basename(cf.url || '')}:${cf.lineNumber + 1}`
  rows.set(key, (rows.get(key) || 0) + us)
  total += us
}
const top = [...rows.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
console.log(`total sampled ${Math.round(total / 1000)} ms`)
for (const [k, us] of top) console.log(String(Math.round(us / 1000)).padStart(7) + ' ms  ' + k)
