'use strict'
// Small memos for the list routes of a big library (docs/PERFORMANCE.md).
//
// A 1,300-show / 40,000-episode library was re-parsing every file name with a dozen regexes, and stat-ing
// every film for its quality badge, on every /api/movies, /api/tvshows and /api/recently-added request.
// The results depend only on the file's name (or, for a stat, on the file, which is re-checked every
// STAT_TTL_MS), so they are kept and reused. Every memo is bounded and simply forgets everything when full.

const fs = require('fs')

const isObject = (v) => v !== null && typeof v === 'object'

// One-level copy, so a caller that edits what it got (title fields, episode info) cannot change the next answer.
function copyResult(r) {
  if (!isObject(r)) return r
  const out = Array.isArray(r) ? r.slice() : { ...r }
  for (const k of Object.keys(out)) if (isObject(out[k])) out[k] = Array.isArray(out[k]) ? out[k].slice() : { ...out[k] }
  return out
}

/** memoized(fileName): fn's answer for that string, copied per call. Non-strings are not memoized. */
function createParseMemo(fn, max = 60000) {
  const memo = new Map()
  return function memoized(input) {
    if (typeof input !== 'string') return fn(input)
    let hit = memo.get(input)
    if (hit === undefined) {
      hit = fn(input)
      if (memo.size >= max) memo.clear()
      memo.set(input, hit)
    }
    return copyResult(hit)
  }
}

/** memo(key, compute): compute() once per key; the same object is returned every time (callers must not edit it). */
function createKeyedMemo(max = 100000) {
  const memo = new Map()
  return function keyed(key, compute) {
    let hit = memo.get(key)
    if (hit === undefined) {
      hit = compute()
      if (memo.size >= max) memo.clear()
      memo.set(key, hit)
    }
    return hit
  }
}

const STAT_TTL_MS = 60 * 1000
const STAT_MAX = 100000
let statCache = new Map()
/**
 * fs.statSync(file) as { mtimeMs, size }, remembered for STAT_TTL_MS (a failure is remembered too and thrown again).
 * `now` and `statFn` are for tests.
 */
function statMemo(file, now = Date.now(), statFn = fs.statSync) {
  const hit = statCache.get(file)
  if (hit && now - hit.at < STAT_TTL_MS) {
    if (hit.error) throw hit.error
    return hit.stat
  }
  let entry
  try {
    const st = statFn(file)
    entry = { at: now, stat: { mtimeMs: st.mtimeMs, size: st.size } }
  } catch (error) {
    entry = { at: now, error }
  }
  if (statCache.size >= STAT_MAX) statCache = new Map()
  statCache.set(file, entry)
  if (entry.error) throw entry.error
  return entry.stat
}
statMemo.clear = () => { statCache = new Map() }

/**
 * lookup(dir, relPath) -> the value `added` (a Map of resolved absolute path -> time) holds for
 * path.resolve(path.join(dir, relPath)), or 0. `relPath` is a walked, normalized relative path (path.relative output).
 * Instead of resolving one path per file, the (few) added paths are split by folder once, then each file is a lookup.
 */
function createAddedLookup(added, pathMod = require('path')) {
  const perDir = new Map() // raw folder -> Map(relPath -> value)
  return function addedAt(dir, relPath) {
    if (!added || !added.size) return 0
    let rels = perDir.get(dir)
    if (rels === undefined) {
      rels = new Map()
      const root = pathMod.resolve(dir)
      const prefix = root.endsWith(pathMod.sep) ? root : root + pathMod.sep
      for (const [p, v] of added) if (p.startsWith(prefix)) rels.set(p.slice(prefix.length), v)
      perDir.set(dir, rels)
    }
    return rels.size ? rels.get(relPath) || 0 : 0
  }
}

/**
 * join(dir, relPath) === pathMod.join(dir, relPath), from one remembered prefix per folder, for a normalized relative
 * path (path.relative output). Anything unusual (empty, absolute, dotted, with '..' or doubled or foreign separators)
 * goes through pathMod.join itself.
 */
function createJoiner(pathMod = require('path')) {
  const prefixes = new Map()
  const foreign = pathMod.sep === '\\' ? '/' : '\\'
  return function join(dir, relPath) {
    if (typeof relPath !== 'string' || !relPath) return pathMod.join(dir, relPath)
    const first = relPath.charAt(0)
    if (first === '.' || first === '/' || first === '\\' || relPath.indexOf(':') !== -1 || relPath.indexOf('..') !== -1 ||
        relPath.indexOf(pathMod.sep + pathMod.sep) !== -1 || relPath.indexOf(foreign) !== -1) return pathMod.join(dir, relPath)
    let prefix = prefixes.get(dir)
    if (prefix === undefined) {
      const probe = pathMod.join(dir, 'x')
      prefix = probe.endsWith('x') ? probe.slice(0, -1) : null
      if (prefixes.size > 64) prefixes.clear()
      prefixes.set(dir, prefix)
    }
    return prefix === null ? pathMod.join(dir, relPath) : prefix + relPath
  }
}

/** True when the object has at least one own key (O(1), unlike Object.keys(...).length). */
function hasEntries(obj) {
  if (!isObject(obj)) return false
  for (const k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) return true
  return false
}

module.exports = { createParseMemo, createKeyedMemo, statMemo, hasEntries, copyResult, createAddedLookup, createJoiner, STAT_TTL_MS }
