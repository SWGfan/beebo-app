'use strict'
// Read cache for the settings store (electron-store / conf, userData/config.json).
//
// conf re-reads and re-parses the WHOLE config.json on every get(): about 75 store.get calls sit in
// streamServer.js and 79 in main.js, a single /api/movies request makes ~5 of them (a movie player
// page ~16, a photo timeline with tokens 200), and secretSettings turns one secret read into two
// (the plain key, then the encrypted-blob table). With a ~200 KB config that is 1-3 ms per get on a
// quiet machine and much more when a scan or a transcode has the disk busy, so a big library's list
// routes spent most of their time re-parsing settings. See docs/PERFORMANCE.md.
//
// cacheStoreReads(store) keeps ONE parsed copy of the file and answers get() from it, as long as the
// file on disk is still the one it was parsed from. Semantics stay those of conf:
//   - every caller still receives its own copy of an object/array value (so mutating what get()
//     returned, a habit all over the app, can never change what the next caller sees), by cloning
//     from a per-key JSON text that is built once per file version;
//   - any write made through this store instance (set, delete, clear, reset, store = {...}) drops the
//     cache before it returns, because they all end in conf's _write();
//   - a write made by anyone else (a second Store on the same file, a restore, an editor, a test)
//     changes the file's mtime/size/inode; that is noticed by a stat, at most `revalidateMs` (25 ms)
//     after the last check, so the next get() re-reads exactly like conf would;
//   - a file that no longer parses makes get() throw the same error conf throws (the original getter
//     is what reads it), and nothing bad is cached;
//   - dotted keys ('license.token'), reserved names and anything unusual are answered by conf itself.
//
// Kill switch: BEEBO_NO_STORE_CACHE=1 leaves the store completely untouched.

const fs = require('fs')

const RESERVED = new Set(['__proto__', 'prototype', 'constructor'])
const isObj = (v) => v !== null && typeof v === 'object'

// Finds the property descriptor of `store` on the instance or up its prototype chain.
function findDescriptor(obj, name) {
  for (let o = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name)
    if (d) return d
  }
  return null
}

function cacheStoreReads(store, options = {}) {
  if (!store || typeof store !== 'object') return store
  if (process.env.BEEBO_NO_STORE_CACHE === '1') return store
  if (store.__beeboReadCache) return store
  // Only a real conf/electron-store: it has a file path, a get(), and the store getter/_write pair
  // this relies on. Anything else (a test's plain object, a fake) is returned unchanged.
  const desc = findDescriptor(store, 'store')
  if (typeof store.path !== 'string' || typeof store.get !== 'function' || typeof store._write !== 'function' || !desc || typeof desc.get !== 'function') return store

  const revalidateMs = options.revalidateMs === undefined ? 25 : options.revalidateMs
  const file = store.path
  const readWhole = () => desc.get.call(store) // conf's own reader: parse + validate, exactly as before
  const origGet = store.get.bind(store)
  const origWrite = store._write.bind(store)

  let snap = null // { data, sig, checkedAt, texts: Map }
  const stats = { hits: 0, reads: 0, statChecks: 0, invalidations: 0 }

  function sigOf() {
    stats.statChecks++
    const st = fs.statSync(file, { bigint: true })
    return st.mtimeNs + ':' + st.size + ':' + st.ino
  }
  function invalidate() {
    if (snap) stats.invalidations++
    snap = null
  }

  // A parsed copy that is known to match the file, or null when the caller should fall back to conf.
  function current() {
    const now = Date.now()
    if (snap) {
      if (revalidateMs > 0 && now - snap.checkedAt < revalidateMs && now >= snap.checkedAt) return snap
      let sig
      try { sig = sigOf() } catch { snap = null; return null }
      if (sig === snap.sig) { snap.checkedAt = now; return snap }
      snap = null
    }
    let sig
    try { sig = sigOf() } catch { return null } // missing file: conf's answer (an empty store) is used as it is
    let data
    try { data = readWhole() } catch { return null } // bad content: conf's get() then throws its own error
    let after
    try { after = sigOf() } catch { return null }
    if (after !== sig) return null // written while it was being read: do not trust either
    stats.reads++
    snap = { data, sig, checkedAt: Date.now(), texts: new Map() }
    return snap
  }

  function fastGet(key, defaultValue) {
    if (typeof key !== 'string' || key === '' || key.indexOf('.') !== -1 || key.indexOf('\\') !== -1 || RESERVED.has(key)) return origGet(key, defaultValue)
    const s = current()
    if (!s) return origGet(key, defaultValue)
    stats.hits++
    const v = s.data[key]
    if (v === undefined) return defaultValue
    if (!isObj(v)) return v
    let text = s.texts.get(key)
    if (text === undefined) { text = JSON.stringify(v); s.texts.set(key, text) }
    return JSON.parse(text)
  }

  store.get = fastGet
  store._write = function cachedStoreWrite(value) {
    invalidate() // before AND after: a failed write must not leave the old copy standing either
    try { return origWrite(value) } finally { invalidate() }
  }
  Object.defineProperty(store, '__beeboReadCache', { value: { stats, invalidate, revalidateMs }, enumerable: false })
  return store
}

module.exports = { cacheStoreReads }
