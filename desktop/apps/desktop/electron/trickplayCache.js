'use strict'
// ============================================================================
// trickplayCache.js - the disk side of seek-bar previews: how big the cache is, which sets were
// used least recently, and dropping them until it fits the owner's limit.
// ----------------------------------------------------------------------------
// A "set" is one directory per file version (see trickplayRules.cacheKeyFor) holding the JPEG frames
// and manifest.json. The manifest's modified time is the set's "last used" stamp: it is written when
// the set is finished and touched (at most once a minute) each time a viewer reads from it, so the
// least recently WATCHED films go first, not the oldest ones. Half-written sets live in "<key>.part"
// directories and are never counted as usable.
// ============================================================================

const fs = require('fs')
const path = require('path')
const rules = require('./trickplayRules')

const MB = 1024 * 1024
const DEFAULT_MAX_MB = 1024
const MIN_MAX_MB = 64
const MAX_MAX_MB = 100 * 1024
const TOUCH_EVERY_MS = 60 * 1000
const STALE_PART_MS = 60 * 60 * 1000

function clampMaxMB(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_MAX_MB
  return Math.min(MAX_MAX_MB, Math.max(MIN_MAX_MB, Math.round(n)))
}

function dirBytes(dir) {
  let total = 0
  let names = []
  try { names = fs.readdirSync(dir) } catch { return 0 }
  for (const n of names) {
    try { total += fs.statSync(path.join(dir, n)).size } catch {}
  }
  return total
}

/** Every finished set under root: { name, dir, bytes, lastUsedMs, manifest }. */
function listSets(root) {
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.endsWith('.part')) continue
    const dir = path.join(root, e.name)
    let st
    try { st = fs.statSync(path.join(dir, 'manifest.json')) } catch { continue }
    let manifest = null
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch {}
    out.push({ name: e.name, dir, bytes: dirBytes(dir), lastUsedMs: st.mtimeMs, manifest })
  }
  return out
}

function totalBytes(root) {
  return listSets(root).reduce((n, s) => n + s.bytes, 0)
}

/**
 * Deletes the least recently used sets until the total is at or under maxBytes. `protect` names
 * sets that must stay (the one being written or just requested). Returns what it did.
 */
function prune(root, { maxBytes, protect = new Set() } = {}) {
  const sets = listSets(root)
  let total = sets.reduce((n, s) => n + s.bytes, 0)
  const removed = []
  if (!(maxBytes >= 0)) return { total, removed }
  const oldestFirst = sets.slice().sort((a, b) => a.lastUsedMs - b.lastUsedMs)
  for (const s of oldestFirst) {
    if (total <= maxBytes) break
    if (protect.has(s.name)) continue
    try { fs.rmSync(s.dir, { recursive: true, force: true }) } catch { continue }
    total -= s.bytes
    removed.push(s.name)
  }
  return { total, removed }
}

/** Removes "<key>.part" directories older than an hour that no running pass owns. */
function sweepStaleParts(root, { now = Date.now(), inFlight = new Set() } = {}) {
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return 0 }
  let n = 0
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('.part')) continue
    if (inFlight.has(e.name.slice(0, -5))) continue
    const dir = path.join(root, e.name)
    try {
      if (now - fs.statSync(dir).mtimeMs < STALE_PART_MS) continue
      fs.rmSync(dir, { recursive: true, force: true })
      n++
    } catch {}
  }
  return n
}

/**
 * ffmpeg's fps filter stops a frame or two short at the end of a file (more on a long-GOP one when
 * only key frames were decoded). The missing tail images are copies of the last real one, so a set
 * always holds exactly the frames its manifest promises and a scrub near the end has a picture.
 */
function fillTail(dir, have, want) {
  if (!(have >= 1) || want <= have) return
  const nameOf = (i) => path.join(dir, rules.frameFileName(i))
  for (let i = have; i < want; i++) fs.copyFileSync(nameOf(have - 1), nameOf(i))
}

/** Marks a set as just used. Cheap enough to call on every frame request. */
function touch(dir, now = Date.now()) {
  const file = path.join(dir, 'manifest.json')
  try {
    if (now - fs.statSync(file).mtimeMs < TOUCH_EVERY_MS) return
    const d = new Date(now)
    fs.utimesSync(file, d, d)
  } catch {}
}

module.exports = { MB, DEFAULT_MAX_MB, MIN_MAX_MB, MAX_MAX_MB, clampMaxMB, dirBytes, listSets, totalBytes, prune, sweepStaleParts, fillTail, touch }
