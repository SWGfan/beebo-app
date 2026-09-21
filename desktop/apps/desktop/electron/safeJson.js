'use strict'
// JSON files that survive a crash, a full disk and a bad edit.
//
// Write: tmp file in the same folder -> fsync -> rename over the target, after
// the previous good file has been copied to `<name>.bak`. A crash at any point
// leaves either the old file or the new one, never half of one.
//
// Read: a file that does not parse is renamed to `<name>.corrupt-<timestamp>`
// (never deleted, never overwritten), and the `.bak` last-good copy is used
// instead. Only when that is unusable too do callers get their defaults, and
// the defaults are NOT written back: the damaged data stays recoverable until
// the next real save.
//
// A read that fails for a reason other than "the content is bad" (permission
// error, file locked by an antivirus scan) is reported, not treated as
// corruption: nothing is renamed, so a transient error can never cost data.

const fs = require('fs')
const path = require('path')

const TRANSIENT_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'EAGAIN', 'EIO'])

let eventSink = null
// Lets the app surface "we recovered a damaged file" without this module knowing about UI.
function setEventSink(fn) { eventSink = typeof fn === 'function' ? fn : null }
function emit(event) {
  try { if (eventSink) eventSink(event) } catch (e) { /* reporting must never break a read */ }
  try { console.warn('[safe-json] ' + event.type + ' ' + path.basename(event.file || '') + (event.detail ? ' (' + event.detail + ')' : '')) } catch (e) { /* ignore */ }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch (e) { /* busy loop is worse; skip the wait */ }
}

function bakPath(file) { return file + '.bak' }
function tmpPath(file) { return file + '.tmp' }

function stamp(now) {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

// Parses text into a value or throws. An empty or whitespace-only file is corrupt,
// not "an empty object": a truncated write looks exactly like that.
function parseStrict(text) {
  if (typeof text !== 'string' || !text.trim()) throw new SyntaxError('empty file')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

function tryRead(file) {
  try {
    return { ok: true, value: parseStrict(fs.readFileSync(file, 'utf8')) }
  } catch (err) {
    return { ok: false, err }
  }
}

function isContentError(err) {
  return err instanceof SyntaxError
}

function uniqueQuarantinePath(file, now) {
  const base = file + '.corrupt-' + stamp(now)
  if (!fs.existsSync(base)) return base
  for (let i = 2; i < 50; i++) if (!fs.existsSync(base + '-' + i)) return base + '-' + i
  return base + '-' + Math.floor(Math.random() * 1e6)
}

function quarantine(file, now) {
  const dest = uniqueQuarantinePath(file, now)
  fs.renameSync(file, dest)
  return dest
}

/**
 * @returns {{ data: any, source: 'file'|'missing'|'backup'|'defaults'|'error', quarantinedTo?: string, error?: Error }}
 * `source: 'error'` means the file could not be read for a non-content reason;
 * `data` is then the `.bak` content if readable, else the defaults, and nothing
 * on disk was touched.
 */
function readJsonSafe(file, defaults, opts) {
  const now = (opts && opts.now) || Date.now()
  const fresh = () => (typeof defaults === 'function' ? defaults() : defaults === undefined ? {} : defaults)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { data: fresh(), source: 'missing' }
    const bak = tryRead(bakPath(file))
    emit({ type: 'read-failed', file, detail: err && err.code })
    return { data: bak.ok ? bak.value : fresh(), source: 'error', error: err }
  }
  try {
    return { data: parseStrict(text), source: 'file' }
  } catch (err) {
    if (!isContentError(err)) return { data: fresh(), source: 'error', error: err }
  }

  let quarantinedTo
  try {
    quarantinedTo = quarantine(file, now)
  } catch (err) {
    emit({ type: 'quarantine-failed', file, detail: err && err.code })
    const bakOnly = tryRead(bakPath(file))
    return { data: bakOnly.ok ? bakOnly.value : fresh(), source: 'error', error: err }
  }
  const bak = tryRead(bakPath(file))
  if (bak.ok) {
    try { fs.copyFileSync(bakPath(file), file) } catch (e) { /* data is still returned; the next save will rewrite the file */ }
    emit({ type: 'restored-from-backup', file, quarantinedTo })
    return { data: bak.value, source: 'backup', quarantinedTo }
  }
  emit({ type: 'reset-to-defaults', file, quarantinedTo })
  return { data: fresh(), source: 'defaults', quarantinedTo }
}

// With backupEveryMs the last-good copy is refreshed at most that often (it is always made
// if there is none yet), so a burst of saves does not copy a large file every time.
function backupDue(file, everyMs) {
  if (!(everyMs > 0)) return true
  try { return Date.now() - fs.statSync(bakPath(file)).mtimeMs >= everyMs } catch (e) { return true }
}

function renameWithRetry(from, to) {
  let lastErr
  for (let i = 0; i < 4; i++) {
    try { fs.renameSync(from, to); return } catch (err) {
      lastErr = err
      if (!err || !TRANSIENT_CODES.has(err.code)) break
      sleepSync(15 * (i + 1))
    }
  }
  throw lastErr
}

/**
 * Atomically replaces `file` with `data` as JSON. Throws on failure (the previous
 * file is left as it was). `.bak` is refreshed only from a file that still parses,
 * so a damaged file can never overwrite the last good copy.
 */
function writeJsonAtomic(file, data, opts) {
  const indent = opts && opts.indent !== undefined ? opts.indent : 2
  const keepBackup = !(opts && opts.backup === false)
  const json = JSON.stringify(data, null, indent)
  if (json === undefined) throw new TypeError('value is not JSON-serialisable')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = tmpPath(file)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, json)
    try { fs.fsyncSync(fd) } catch (e) { /* some filesystems refuse; the rename is still atomic */ }
  } catch (err) {
    try { fs.closeSync(fd) } catch (e) { /* ignore */ }
    try { fs.unlinkSync(tmp) } catch (e) { /* ignore */ }
    throw err
  }
  fs.closeSync(fd)
  // assumeValid: the caller knows the file on disk is the one it last read or wrote, so parsing
  // it again is wasted work (a large manifest saved once per title while matching a library).
  const current = opts && opts.assumeValid && fs.existsSync(file) ? { ok: true } : tryRead(file)
  if (current.ok) {
    if (keepBackup && backupDue(file, opts && opts.backupEveryMs)) {
      try { fs.copyFileSync(file, bakPath(file)) } catch (e) { /* a missing backup must not block saving */ }
    }
  } else if (isContentError(current.err)) {
    // Saving over damaged content: keep it aside rather than lose it for good.
    try { emit({ type: 'quarantined-on-write', file, quarantinedTo: quarantine(file, Date.now()) }) } catch (e) { /* the rename below still replaces it */ }
  }
  try {
    renameWithRetry(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch (e) { /* ignore */ }
    throw err
  }
}

module.exports = { readJsonSafe, writeJsonAtomic, setEventSink, parseStrict, bakPath, tmpPath }
