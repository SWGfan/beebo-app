#!/usr/bin/env node
'use strict'
// Which module loads cost the most at startup (docs/PERFORMANCE.md, "startup"):
//   node test/perf/require-profile.js [entry ...]     default entry: ../../electron/streamServer.js
// Prints the total load time and the top modules by SELF time (time inside the module's own
// top-level code, children excluded). Run it on a fresh process each time: a second load is cached.
const Module = require('node:module')
const path = require('node:path')

const entries = process.argv.slice(2)
if (!entries.length) entries.push(path.join(__dirname, '..', '..', 'electron', 'streamServer.js'))

const stack = []
const rows = new Map()
const origLoad = Module._load
Module._load = function patched(request, parent, isMain) {
  const t0 = process.hrtime.bigint()
  const frame = { child: 0n }
  stack.push(frame)
  try { return origLoad.apply(this, arguments) } finally {
    stack.pop()
    const total = process.hrtime.bigint() - t0
    const self = total - frame.child
    if (stack.length) stack[stack.length - 1].child += total
    let name = request
    try { name = path.relative(path.join(__dirname, '..', '..'), Module._resolveFilename(request, parent, isMain)).replace(/\\/g, '/') } catch { /* keep the request */ }
    const r = rows.get(name) || { self: 0n, total: 0n, count: 0 }
    if (total > 50000n || r.count === 0) { r.self += self; r.total += total }
    r.count++
    rows.set(name, r)
  }
}

const t0 = process.hrtime.bigint()
for (const e of entries) require(path.resolve(e))
const total = Number(process.hrtime.bigint() - t0) / 1e6
const top = [...rows.entries()].map(([name, r]) => ({ name, selfMs: Number(r.self) / 1e6 })).filter((r) => r.selfMs >= 0.5).sort((a, b) => b.selfMs - a.selfMs).slice(0, 25)
console.log(JSON.stringify({ entries, totalMs: Math.round(total), modulesLoaded: rows.size, top: top.map((r) => ({ name: r.name, selfMs: Math.round(r.selfMs * 10) / 10 })) }, null, 2))
