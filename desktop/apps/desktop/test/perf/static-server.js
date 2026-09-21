#!/usr/bin/env node
'use strict'
// Tiny static file server for the browser-side benchmarks (renderer-grid.html) and for smoke-testing a Vite build.
//   node test/perf/static-server.js [--port 5599] [--dist <vite outDir>]
// Serves apps/desktop (so /test/perf/renderer-grid.html and /src/styles.css work); with --dist the built app is also
// served under /app/, with a mock window.beeboentertainment injected so the renderer can boot without Electron.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const argOf = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const port = Number(argOf('port', 5599))
const dist = argOf('dist', '')
const root = path.join(__dirname, '..', '..')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const MOCK = '<script>window.beeboentertainment = new Proxy({}, { get: (t, k) => (k === "then" ? undefined : (...a) => Promise.resolve(k.startsWith("on") ? (() => {}) : { ok: true, enforced: false, homeAllowed: true, serve: true })) })</script>'

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let base = root
  let rel = decodeURIComponent(url.pathname)
  if (dist && (rel === '/app' || rel.startsWith('/app/'))) { base = path.resolve(dist); rel = rel.slice(4) || '/' }
  if (rel.endsWith('/')) rel += 'index.html'
  const file = path.resolve(base, '.' + rel)
  if (!file.startsWith(base)) { res.writeHead(403); res.end(); return }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return }
    if (base !== root && path.basename(file) === 'index.html') buf = Buffer.from(buf.toString('utf8').replace('<head>', '<head>' + MOCK))
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(buf)
  })
}).listen(port, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + port))
