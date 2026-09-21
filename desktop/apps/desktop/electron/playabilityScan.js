'use strict'
// ============================================================================
// playabilityScan.js — "Scan the whole library for files that will not play".
// ----------------------------------------------------------------------------
// The admin route used to await one ffprobe per file, in order, inside the HTTP
// request: a 2,000-file library meant 2,000 probes back to back and a browser
// tab spinning the whole time. This module runs the same verdict three ways
// faster and without holding the request:
//
//   * A BOUNDED POOL. Up to `concurrency` probes at once (CPU cores by default).
//     Each probe is its own ffprobe process, so the work is off the main event
//     loop; the loop only stats the file and reads a few hundred bytes of JSON.
//   * A PROBE CACHE keyed by path + size + mtime. A rescan only probes files that
//     are new or have changed since. Only successful probes are cached: a probe
//     that timed out or failed gives the same verdict as before, but is tried
//     again next time rather than remembered.
//   * THE STREAMS DECIDE. With decide() (playbackRules) every file is probed: an
//     .mkv or .avi is a container, and an H.264/AAC .mkv plays as it is. The old
//     isBrowserPlayable() mode, which skipped the probe when the extension alone
//     refused a file, is only kept for older callers.
//
// Files are handed to onNeeds() in the same order the old loop visited
// them (movies, then TV, walk order), so the conversion queue ends up the same.
//
// It runs as a background job with a status the admin page polls, and it can be
// cancelled: probes in flight are killed, their (now meaningless) results are
// thrown away, and everything already decided is still queued.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')

// 2: probes carry every stream, profile, bit depth and the real container (playbackRules).
const CACHE_VERSION = 2

function defaultConcurrency() {
  let cores = 0
  try { cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length } catch (_) {}
  return Math.max(2, Math.min(Number(cores) || 2, 16))
}

// Run worker(item, index) over items with at most `limit` running at once.
// Stops starting new work once shouldStop() is true; always waits for the ones
// already running. Resolves to the number of items that were started.
async function runPool(items, limit, worker, { shouldStop } = {}) {
  const n = Array.isArray(items) ? items.length : 0
  const width = Math.max(1, Math.min(Number(limit) || 1, n || 1))
  let next = 0
  let started = 0
  const lane = async () => {
    while (next < n) {
      if (typeof shouldStop === 'function' && shouldStop()) return
      const i = next++
      started++
      try { await worker(items[i], i) } catch (_) {}
    }
  }
  const lanes = []
  for (let k = 0; k < width; k++) lanes.push(lane())
  await Promise.all(lanes)
  return started
}

// path -> { size, mtimeMs, probe }. Persisted as one small JSON file when a
// file path is given; memory only otherwise.
function createProbeCache({ file } = {}) {
  let entries = new Map()
  let loaded = false
  let dirty = false
  const statKey = (st) => ({ size: Number(st && st.size), mtimeMs: Number(st && st.mtimeMs) })

  async function load() {
    if (loaded) return
    loaded = true
    if (!file) return
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'))
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        entries = new Map(Object.entries(parsed.entries))
      }
    } catch (_) { /* missing or damaged: start empty */ }
  }
  // undefined = not cached (or stale); otherwise the cached probe object.
  function get(filePath, st) {
    const e = entries.get(filePath)
    if (!e || !st) return undefined
    const k = statKey(st)
    if (e.size !== k.size || e.mtimeMs !== k.mtimeMs) return undefined
    return e.probe
  }
  function set(filePath, st, probe) {
    if (!st || !probe) return
    entries.set(filePath, { ...statKey(st), probe })
    dirty = true
  }
  // Drop rows for files that were not seen in a complete walk.
  function retainOnly(paths) {
    const keep = new Set(paths)
    for (const k of entries.keys()) if (!keep.has(k)) { entries.delete(k); dirty = true }
  }
  async function save() {
    if (!file || !dirty) return
    dirty = false
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await fs.promises.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(entries) }))
      await fs.promises.rename(tmp, file)
    } catch (_) { dirty = true }
  }
  return { load, get, set, save, retainOnly, size: () => entries.size, file }
}

// A probe that every browser-playable rule accepts. If isBrowserPlayable still
// says no with THIS, the extension alone has decided and probing is pointless.
const PERFECT_PROBE = Object.freeze({ videoCodec: 'h264', audioCodec: 'aac', videoLevel: 40, videoPixFmt: 'yuv420p', hasAudio: true, durationSec: 1 })

// Two ways to give the verdict:
//   decide(probe, ext) -> a playbackRules decision; needsWork(decision) says whether to queue.
//     Every file is probed (the extension never decides) and onNeeds(file, decision) gets it.
//   isBrowserPlayable(probe, ext) -> the legacy boolean rule, kept for older callers and tests.
function createUnplayableScanner({ probe, isBrowserPlayable, decide, needsWork, cache, concurrency, stat, log } = {}) {
  const useDecide = typeof decide === 'function'
  if (typeof probe !== 'function' || (!useDecide && typeof isBrowserPlayable !== 'function')) throw new Error('probe and decide (or isBrowserPlayable) required')
  const wants = typeof needsWork === 'function' ? needsWork : (d) => !!d && ['remux', 'audio', 'video'].includes(d.action)
  const probeCache = cache || createProbeCache({})
  const statFn = stat || ((p) => fs.promises.stat(p))
  const say = (m) => { try { if (typeof log === 'function') log(m) } catch (_) {} }
  const width = () => Number(concurrency) > 0 ? Math.floor(Number(concurrency)) : defaultConcurrency()

  let job = null
  let last = null

  const snapshot = (j) => j ? {
    state: j.state,
    total: j.total,
    checked: j.checked,
    probed: j.probed,
    fromCache: j.fromCache,
    skippedByExtension: j.skippedByExtension,
    needsConversion: j.needsConversion,
    enqueued: j.enqueued,
    concurrency: j.concurrency,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt || null,
    elapsedMs: (j.finishedAt || Date.now()) - j.startedAt,
    error: j.error || null
  } : { state: 'idle' }

  function status() { return snapshot(job || last) }
  function running() { return !!(job && (job.state === 'listing' || job.state === 'scanning')) }

  function cancel() {
    if (!running()) return { cancelled: false, scan: status() }
    job.cancelRequested = true
    try { job.abort.abort() } catch (_) {}
    return { cancelled: true, scan: status() }
  }

  // listFiles(): Promise<[{ path, kind }]> in the order they should be queued.
  // onNeeds({ path, kind }): called in that order for each file that will not
  // play; return true when it was newly queued.
  function start({ listFiles, onNeeds } = {}) {
    if (running()) return { started: false, scan: status() }
    const j = {
      state: 'listing', total: 0, checked: 0, probed: 0, fromCache: 0, skippedByExtension: 0,
      needsConversion: 0, enqueued: 0, concurrency: width(), startedAt: Date.now(), finishedAt: 0,
      error: null, cancelRequested: false, abort: new AbortController()
    }
    job = j
    j.done = run(j, listFiles, onNeeds).catch((err) => {
      j.error = String((err && err.message) || err)
      j.state = 'error'
    }).finally(() => {
      if (!j.finishedAt) j.finishedAt = Date.now()
      last = j
      if (job === j) job = null
    })
    return { started: true, scan: status(), done: j.done }
  }

  async function run(j, listFiles, onNeeds) {
    const files = (await listFiles()) || []
    await probeCache.load()
    if (j.cancelRequested) { j.state = 'cancelled'; return }
    j.total = files.length
    j.state = 'scanning'

    const SKIP = 0, OK = 1, NEEDS = 2
    const verdicts = new Array(files.length)
    const decisions = new Array(files.length)
    let cursor = 0
    let sinceSave = 0
    const commit = (flushGaps) => {
      while (cursor < files.length && (verdicts[cursor] !== undefined || flushGaps)) {
        const v = verdicts[cursor]
        if (v === NEEDS) {
          j.needsConversion++
          try { if (typeof onNeeds === 'function' && onNeeds(files[cursor], decisions[cursor])) j.enqueued++ } catch (_) {}
        }
        cursor++
      }
    }

    const worker = async (file, i) => {
      const filePath = file && file.path
      const ext = path.extname(String(filePath || '')).toLowerCase()
      let needs = false
      let aborted = false
      try {
        if (!useDecide && !isBrowserPlayable(PERFECT_PROBE, ext)) {
          needs = !isBrowserPlayable(null, ext)
          j.skippedByExtension++
        } else {
          let st = null
          try { st = await statFn(filePath) } catch (_) { st = null }
          let pr = st ? probeCache.get(filePath, st) : undefined
          if (pr !== undefined) {
            j.fromCache++
          } else {
            pr = await probe(filePath, { signal: j.abort.signal })
            if (j.cancelRequested) aborted = true
            else {
              j.probed++
              if (pr && st) { probeCache.set(filePath, st, pr); sinceSave++ }
            }
          }
          if (!aborted) {
            if (useDecide) { decisions[i] = decide(pr, ext); needs = wants(decisions[i]) }
            else needs = !isBrowserPlayable(pr, ext)
          }
        }
      } catch (_) { needs = false }
      if (aborted) { verdicts[i] = SKIP; return }
      verdicts[i] = needs ? NEEDS : OK
      j.checked++
      commit(false)
      if (sinceSave >= 200) { sinceSave = 0; probeCache.save() }
    }

    await runPool(files, j.concurrency, worker, { shouldStop: () => j.cancelRequested })
    // Anything decided is queued, in order, even after a cancel.
    commit(true)
    if (!j.cancelRequested) probeCache.retainOnly(files.map((f) => f.path))
    await probeCache.save()
    j.finishedAt = Date.now()
    j.state = j.cancelRequested ? 'cancelled' : 'done'
    say(`unplayable scan ${j.state}: ${j.checked}/${j.total} checked, ${j.probed} probed, ${j.fromCache} from cache, ${j.skippedByExtension} by extension, ${j.enqueued} queued in ${j.finishedAt - j.startedAt} ms (pool ${j.concurrency})`)
  }

  return { start, cancel, status, running, cache: probeCache }
}

module.exports = { runPool, createProbeCache, createUnplayableScanner, defaultConcurrency, PERFECT_PROBE }
