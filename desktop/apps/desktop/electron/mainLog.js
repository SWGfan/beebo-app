'use strict'
// A rolling on-disk copy of everything the main process prints (console.log/warn/error,
// which includes the media server's own log lines, since main.js passes them through
// console). A packaged Electron app has no visible console, so without this a crash leaves
// nothing to look at.
//
//   <dir>/main.log, main.1.log ... main.<keep>.log   (rotates when main.log passes maxBytes)
//
// Every line is run through logRedact.js BEFORE it is buffered, so a token can never reach
// the disk. Lines are batched and written every few hundred milliseconds, so a chatty
// server does not turn into thousands of tiny synchronous writes.

const fs = require('fs')
const path = require('path')
const util = require('util')
const { redact } = require('./logRedact')

const DEFAULTS = { maxBytes: 2 * 1024 * 1024, keep: 5, flushMs: 400, maxBuffered: 256 * 1024 }
const LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' }

function createMainLog(options) {
  const o = Object.assign({}, DEFAULTS, options || {})
  const dir = o.dir
  const file = path.join(dir, 'main.log')
  const rotated = (i) => path.join(dir, 'main.' + i + '.log')
  const now = o.now || (() => Date.now())
  let buffer = []
  let bufferedBytes = 0
  let dropped = 0
  let timer = null
  let size = -1
  let disabled = false

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); return true } catch (e) { return false }
  }

  function rotate() {
    try { fs.unlinkSync(rotated(o.keep)) } catch (e) { /* not there yet */ }
    for (let i = o.keep - 1; i >= 1; i--) {
      try { fs.renameSync(rotated(i), rotated(i + 1)) } catch (e) { /* gap in the sequence is fine */ }
    }
    try { fs.renameSync(file, rotated(1)) } catch (e) {
      // Windows can refuse while another process holds the file; truncating still bounds the size.
      try { fs.writeFileSync(file, '') } catch (e2) { /* give up until next time */ }
    }
    size = 0
  }

  function flushSync() {
    if (timer) { clearTimeout(timer); timer = null }
    if (disabled || !buffer.length) { buffer = []; bufferedBytes = 0; return }
    let text = buffer.join('')
    if (dropped) text = new Date(now()).toISOString() + ' WARN [log] ' + dropped + ' log line(s) were dropped because the log was written to faster than it could be saved\n' + text
    buffer = []
    bufferedBytes = 0
    dropped = 0
    try {
      if (!ensureDir()) return
      if (size < 0) { try { size = fs.statSync(file).size } catch (e) { size = 0 } }
      if (size > 0 && size + Buffer.byteLength(text) > o.maxBytes) rotate()
      fs.appendFileSync(file, text)
      size += Buffer.byteLength(text)
    } catch (e) {
      // Logging must never take the app down. Stop trying if the disk is unusable.
      if (e && (e.code === 'EROFS' || e.code === 'EACCES' || e.code === 'EPERM')) disabled = true
    }
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(flushSync, o.flushMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function write(level, text) {
    let line
    try {
      line = new Date(now()).toISOString() + ' ' + (level || 'INFO') + ' ' + redact(text, o.redactOptions) + '\n'
    } catch (e) {
      line = new Date(now()).toISOString() + ' WARN [log] a line could not be written safely and was dropped\n'
    }
    const bytes = Buffer.byteLength(line)
    if (bufferedBytes + bytes > o.maxBuffered) {
      while (buffer.length && bufferedBytes + bytes > o.maxBuffered) { bufferedBytes -= Buffer.byteLength(buffer.shift()); dropped++ }
    }
    buffer.push(line)
    bufferedBytes += bytes
    if (level === 'ERROR') flushSync()
    else schedule()
  }

  function install(target) {
    const c = target || console
    const originals = {}
    for (const method of Object.keys(LEVELS)) {
      const orig = c[method]
      if (typeof orig !== 'function') continue
      originals[method] = orig
      c[method] = function (...args) {
        try { write(LEVELS[method], util.format(...args)) } catch (e) { /* never break the caller */ }
        try { return orig.apply(this, args) } catch (e) { /* stdout may be a closed pipe */ }
      }
    }
    return function uninstall() {
      for (const [method, orig] of Object.entries(originals)) c[method] = orig
    }
  }

  function readTail(maxBytes) {
    flushSync()
    const want = maxBytes || 64 * 1024
    let out = ''
    for (const f of [file, rotated(1)]) {
      if (out.length >= want) break
      try {
        const st = fs.statSync(f)
        const take = Math.min(st.size, want - out.length)
        const fd = fs.openSync(f, 'r')
        try {
          const buf = Buffer.alloc(take)
          fs.readSync(fd, buf, 0, take, st.size - take)
          out = buf.toString('utf8') + out
        } finally { fs.closeSync(fd) }
      } catch (e) { /* file may not exist yet */ }
    }
    const firstNl = out.indexOf('\n')
    return out.length >= want && firstNl >= 0 ? out.slice(firstNl + 1) : out
  }

  return { write, flushSync, install, readTail, file, dir, rotatedPath: rotated }
}

// The most recent WARN/ERROR entries (with their continuation lines, e.g. stack frames)
// out of log text, oldest first.
function lastProblems(text, count) {
  const lines = String(text || '').split('\n')
  const isHead = (l) => /^\d{4}-\d\d-\d\dT[\d:.]+Z (INFO|WARN|ERROR|DEBUG) /.test(l)
  const entries = []
  let cur = null
  for (const l of lines) {
    if (isHead(l)) { cur = { head: l, rest: [] }; entries.push(cur) } else if (cur && l) cur.rest.push(l)
  }
  return entries
    .filter((e) => / (WARN|ERROR) /.test(e.head.slice(0, 40)))
    .slice(-count)
    .map((e) => [e.head].concat(e.rest.slice(0, 12)).join('\n'))
}

module.exports = { createMainLog, lastProblems, DEFAULTS }
