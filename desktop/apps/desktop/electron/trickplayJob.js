'use strict'
// ============================================================================
// trickplayJob.js - when seek-bar previews get made. Orchestration only; the ffmpeg pass itself and
// the disk cache live in playbackApi.js and trickplayCache.js.
// ----------------------------------------------------------------------------
// Same low-impact shape as the intro/credits scanner (introDetectJob.js):
//   * ONE pass at a time per lane, below-normal priority (the caller spawns it that way).
//   * BACKGROUND work (the library sweep, so previews exist before anyone asks) waits, between
//     files and never in the middle of one, while anyone is watching, a live conversion is running or
//     the converter queue is busy, and resumes on its own when the house goes quiet.
//   * URGENT work (a viewer opened a film that has no set yet) is its own lane and does NOT wait:
//     the viewer asking is by definition a stream in progress, and the pass only decodes key frames.
//   * The sweep never evicts anything to make room: when the cache is 90% full it stops for the
//     day, so a library bigger than the limit cannot spin, generating and deleting the same sets.
//   * A file that cannot be done (too short, unreadable, ffmpeg failed) is remembered and left alone
//     for a while, so a restart does not retry thousands of files.
// ============================================================================

const DAY = 24 * 60 * 60 * 1000
const SKIP_STORE_KEY = 'trickplaySkips'
const RETRY_INELIGIBLE_MS = 30 * DAY
const RETRY_FAILED_MS = 7 * DAY
const MAX_SKIP_RECORDS = 5000
const FULL_AT = 0.9

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref() })

function createTrickplayQueue({ isBusy = () => false, enabled = () => true, sleep = defaultSleep, pollMs = 15000, pauseBetweenMs = 250, log = () => {} } = {}) {
  const lanes = { urgent: { queue: [], running: false }, background: { queue: [], running: false } }
  const known = new Map() // key -> { promise, lane, job }
  let stopped = false
  let pausedForBusy = false

  async function waitIdle(stillWanted = () => true) {
    for (;;) {
      if (stopped || !stillWanted()) { pausedForBusy = false; return false }
      if (!enabled()) return false
      let busy = false
      try { busy = !!isBusy() } catch { busy = false }
      if (!busy) { pausedForBusy = false; return true }
      pausedForBusy = true
      await sleep(pollMs)
    }
  }

  async function pump(name) {
    const lane = lanes[name]
    if (lane.running) return
    lane.running = true
    try {
      while (lane.queue.length && !stopped) {
        const job = lane.queue[0]
        let result = { state: 'aborted' }
        try {
          const go = name === 'urgent' ? enabled() : await waitIdle(() => lane.queue[0] === job)
          // Left in place while waiting so an urgent request can still take it away.
          if (lane.queue[0] !== job) continue
          lane.queue.shift()
          if (go) result = (await job.task()) || { state: 'failed' }
        } catch (e) {
          log(`seek previews: ${job.key} failed (${e && e.message})`)
          result = { state: 'failed' }
        }
        known.delete(job.key)
        job.resolve(result)
        if (pauseBetweenMs && lane.queue.length) await sleep(pauseBetweenMs)
      }
    } finally {
      lane.running = false
    }
  }

  /**
   * Runs task() in the given lane and resolves with its result ({ state: 'ready' | 'ineligible' |
   * 'failed' | 'aborted', ... }). The same key twice shares one run; an urgent request for a key that
   * is still waiting in the background lane moves it to the front of the urgent one.
   */
  function enqueue(key, task, { urgent = false } = {}) {
    const existing = known.get(key)
    if (existing) {
      if (urgent && existing.lane === 'background' && lanes.background.queue.includes(existing.job)) {
        lanes.background.queue.splice(lanes.background.queue.indexOf(existing.job), 1)
        existing.lane = 'urgent'
        lanes.urgent.queue.push(existing.job)
        pump('urgent')
      }
      return existing.promise
    }
    const laneName = urgent ? 'urgent' : 'background'
    const job = { key, task, resolve: null }
    const promise = new Promise((resolve) => { job.resolve = resolve })
    known.set(key, { promise, lane: laneName, job })
    lanes[laneName].queue.push(job)
    pump(laneName)
    return promise
  }

  function stop() {
    stopped = true
    for (const lane of Object.values(lanes)) {
      for (const job of lane.queue.splice(0)) { known.delete(job.key); job.resolve({ state: 'aborted' }) }
    }
  }

  const has = (key) => known.has(key)
  const status = () => ({
    running: lanes.urgent.running || lanes.background.running,
    queued: lanes.urgent.queue.length + lanes.background.queue.length,
    paused: pausedForBusy ? 'playback' : null
  })

  return { enqueue, stop, has, status }
}

function createTrickplaySweep({
  store,
  queue,
  listItems,                 // async () => [{ path }]
  generate,                  // async (filePath, { background: true }) => { state, bytes? }
  readyIdentities,           // () => Set of "path|size|mtime" that already have a finished set
  usedBytes,                 // () => bytes the cache holds right now
  maxBytes,                  // () => the owner's limit
  statFile,                  // (path) => { size, mtimeMs } | null
  identityOf,                // (path, size, mtimeMs) => string
  enabled = () => true,
  log = () => {},
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  startDelayMs = 4 * 60 * 1000,
  intervalMs = 60 * 60 * 1000
}) {
  let running = false
  let stopped = false
  let firstTimer = null
  let repeatTimer = null
  let skips = null
  const st = { phase: 'idle', done: 0, lastPassAt: null, stoppedBecause: '' }

  function loadSkips() {
    if (skips) return skips
    let raw = null
    try { raw = store.get(SKIP_STORE_KEY) } catch {}
    skips = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
    return skips
  }
  function saveSkips() {
    const s = loadSkips()
    const keys = Object.keys(s)
    if (keys.length > MAX_SKIP_RECORDS) {
      keys.sort((a, b) => (s[a].at || 0) - (s[b].at || 0))
      for (const k of keys.slice(0, keys.length - MAX_SKIP_RECORDS)) delete s[k]
    }
    try { store.set(SKIP_STORE_KEY, s) } catch {}
  }

  async function runPass() {
    if (running || stopped || !enabled()) return st
    running = true
    st.phase = 'scanning'
    st.done = 0
    st.stoppedBecause = ''
    try {
      let items = []
      try { items = (await listItems()) || [] } catch (e) { log(`seek previews: could not list the library (${e && e.message})`); items = [] }
      const ready = readyIdentities()
      const limit = maxBytes()
      let used = usedBytes()
      const s = loadSkips()
      let dirty = false
      for (const item of items) {
        if (stopped || !enabled()) { st.stoppedBecause = stopped ? 'stopped' : 'disabled'; break }
        if (!item || !item.path) continue
        const stat = statFile(item.path)
        if (!stat) continue
        const identity = identityOf(item.path, stat.size, stat.mtimeMs)
        if (ready.has(identity)) continue
        const rec = s[identity]
        if (rec && rec.retryAt > now()) continue
        if (used >= limit * FULL_AT) { st.stoppedBecause = 'cache_full'; break }
        st.phase = 'generating'
        const r = await queue.enqueue(identity, () => generate(item.path, { background: true }), { urgent: false })
        if (!r || r.state === 'aborted') { if (stopped || !enabled()) break; continue }
        if (r.state === 'ready') {
          used += r.bytes || 0
          st.done++
          if (rec) { delete s[identity]; dirty = true }
        } else {
          s[identity] = { state: r.state, at: now(), retryAt: now() + (r.state === 'ineligible' ? RETRY_INELIGIBLE_MS : RETRY_FAILED_MS) }
          dirty = true
        }
      }
      if (dirty) saveSkips()
    } finally {
      running = false
      st.phase = 'idle'
      st.lastPassAt = now()
    }
    return st
  }

  function start() {
    if (firstTimer || repeatTimer || stopped) return
    firstTimer = timers.setTimeout(() => { firstTimer = null; runPass().catch(() => {}) }, startDelayMs)
    if (firstTimer && firstTimer.unref) firstTimer.unref()
    repeatTimer = timers.setInterval(() => { runPass().catch(() => {}) }, intervalMs)
    if (repeatTimer && repeatTimer.unref) repeatTimer.unref()
  }
  function stop() {
    stopped = true
    if (firstTimer) timers.clearTimeout(firstTimer)
    if (repeatTimer) timers.clearInterval(repeatTimer)
    firstTimer = repeatTimer = null
  }

  return { start, stop, runPass, status: () => ({ ...st }) }
}

module.exports = { createTrickplayQueue, createTrickplaySweep, SKIP_STORE_KEY, RETRY_INELIGIBLE_MS, RETRY_FAILED_MS, FULL_AT }
