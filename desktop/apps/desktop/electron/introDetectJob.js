'use strict'
// ============================================================================
// introDetectJob.js - the background scanner behind "Detect intros and credits
// automatically". Pure orchestration around introDetect.js: what to scan, when it
// is polite to scan, and where the answers are kept.
// ----------------------------------------------------------------------------
//   * LOCAL ONLY: it runs the bundled ffmpeg on files in the library and stores small
//     numbers in the settings file. Nothing is uploaded, no network call is made.
//   * LOW IMPACT: one ffmpeg/ffprobe process at a time (concurrency is a setting,
//     default 1), spawned at below-normal priority, a short pause between processes,
//     and it WAITS - between processes, never mid-file - while anyone is watching,
//     a live conversion is running, or the converter queue is working. It resumes by
//     itself when the house goes quiet.
//   * INCREMENTAL + RESUMABLE: results are keyed by file identity (path|size|mtime), so
//     only new or changed files are analysed; each episode's fingerprint is cached on
//     disk so a restart mid-season (or one new episode) does not decode the season
//     again. Progress is simply "which records exist", so there is nothing to lose.
//   * SAFE: a file that fails (ffmpeg error, timeout, no audio) is remembered and left
//     alone for a week; a missing file is skipped; nothing here can throw into the server.
// Where the answers land: store key 'autoMarkers' = { [identity]: record }. Viewer-set
// markers ('playbackMarkers') are a separate key and always win - see markerModel.js.
// ============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const detect = require('./introDetect')
const model = require('./markerModel')
const safeJson = require('./safeJson')

const STORE_KEY = 'autoMarkers'
const STATE_KEY = 'autoMarkerScan'
const ENABLED_KEY = 'autoMarkersEnabled'
const DAY = 24 * 60 * 60 * 1000
const RETRY_AFTER_MS = 7 * DAY
const PRUNE_AFTER_MS = 90 * DAY
const FP_MAGIC = 0x31504642 // 'BFP1'
const ABORTED = Symbol('aborted')

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')

function defaultStat(p) {
  try {
    const st = fs.statSync(p)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

// --------------------------------------------------- fingerprint disk cache
function fpCachePath(dir, identity) {
  return path.join(dir, sha1(identity + '|v' + detect.DETECTOR_VERSION) + '.fp')
}

function writeFp(dir, identity, fp) {
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    const n = fp.frames
    const buf = Buffer.alloc(8 + n * 4 + n)
    buf.writeUInt32LE(FP_MAGIC, 0)
    buf.writeUInt32LE(n, 4)
    for (let i = 0; i < n; i++) buf.writeInt32LE(fp.hashes[i], 8 + i * 4)
    for (let i = 0; i < n; i++) buf[8 + n * 4 + i] = fp.active[i]
    const tmp = fpCachePath(dir, identity) + '.tmp'
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, fpCachePath(dir, identity))
  } catch (_) {}
}

function readFp(dir, identity) {
  if (!dir) return null
  try {
    const buf = fs.readFileSync(fpCachePath(dir, identity))
    if (buf.length < 8 || buf.readUInt32LE(0) !== FP_MAGIC) return null
    const n = buf.readUInt32LE(4)
    if (buf.length !== 8 + n * 5) return null
    const hashes = new Int32Array(n)
    const active = new Uint8Array(n)
    for (let i = 0; i < n; i++) hashes[i] = buf.readInt32LE(8 + i * 4)
    for (let i = 0; i < n; i++) active[i] = buf[8 + n * 4 + i]
    return { hashes, active, frames: n, seconds: (n * detect.HOP) / detect.SAMPLE_RATE }
  } catch {
    return null
  }
}

function dropFp(dir, identity) {
  if (!dir) return
  try { fs.unlinkSync(fpCachePath(dir, identity)) } catch (_) {}
}

function pruneFpCache(dir, now) {
  if (!dir) return
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.fp') && !name.endsWith('.tmp')) continue
      const p = path.join(dir, name)
      try { if (now - fs.statSync(p).mtimeMs > 60 * DAY) fs.unlinkSync(p) } catch (_) {}
    }
  } catch (_) {}
}

// A season's identity: which files are in it. New/removed/changed episode -> new signature -> the
// season's consensus is recomputed (from cached fingerprints, so cheaply).
const PROGRESS_EVERY_MS = 3000 // how often the "n of m" count is recomputed while a pass runs

function seasonSignature(identities) {
  return sha1(identities.slice().sort().join('\n') + '|v' + detect.DETECTOR_VERSION).slice(0, 12)
}

function createIntroScanner({
  store,
  listItems,                 // () => [{ kind:'tv'|'movie', id, path, showKey, showName, season, episode, label }]
  isBusy = () => false,      // true while playback / live conversion / the converter queue is working
  ffmpegPath = () => null,
  ffprobePath = () => null,
  cacheDir = () => null,
  log = () => {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref() }),
  statFile = defaultStat,
  spawnFn,
  priority = true,
  settings = {},             // { enabled(), concurrency(), fullDecode() } - read fresh on every use
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  // Where the records live. Undefined: next to the settings file (auto-markers.json) when the store has a file path,
  // else under the 'autoMarkers' store key as before. null forces the store key.
  recordsFile,
  startDelayMs = 3 * 60 * 1000,
  intervalMs = 30 * 60 * 1000,
  pollMs = 15000,            // how often to re-check "is anyone watching?" while paused
  pauseBetweenMs = 250,      // breathing room between two ffmpeg processes
  // Injected in tests; the defaults are the real thing.
  probe = detect.probeDuration,
  extract = detect.extractFingerprint,
  analyseTail = detect.analyseTail,
  detectSeason = detect.detectSeasonIntros
} = {}) {
  const enabled = () => { try { return settings.enabled ? settings.enabled() !== false : store.get(ENABLED_KEY) !== false } catch { return true } }
  const concurrency = () => { try { return Math.min(2, Math.max(1, Number(settings.concurrency ? settings.concurrency() : 1) || 1)) } catch { return 1 } }
  const fullDecode = () => { try { return !!(settings.fullDecode && settings.fullDecode()) } catch { return false } }

  let records = null
  let saveTimer = null
  let stopped = false
  let running = false
  let rerun = false
  let firstTimer = null
  let repeatTimer = null
  let liveIds = new Set()
  const st = {
    phase: 'idle', current: '', paused: null, itemsTotal: 0, itemsDone: 0,
    lastPassAt: null, lastPassMs: null, lastError: '', passes: 0
  }
  try { const saved = store.get(STATE_KEY); if (saved && typeof saved === 'object') { st.lastPassAt = saved.lastPassAt || null; st.lastPassMs = saved.lastPassMs || null; st.itemsTotal = saved.itemsTotal || 0; st.itemsDone = saved.itemsDone || 0 } } catch (_) {}

  // ------------------------------------------------------------- records
  // One record per library file: about 500 bytes each, so 20 MB for 40,000 episodes. Kept inside config.json that
  // made every settings write (any viewer's progress, every 15 s) rewrite tens of megabytes; it lives in its own
  // file now, written at most every few seconds. What an older build left under the 'autoMarkers' key is moved
  // over once, and only removed from config.json after the new file is safely written.
  const isRecords = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  const fileForRecords = recordsFile !== undefined ? recordsFile : (typeof store.path === 'string' && store.path ? path.join(path.dirname(store.path), 'auto-markers.json') : null)
  let lastFileWrite = 0
  function load() {
    if (records) return records
    if (fileForRecords) {
      const r = safeJson.readJsonSafe(fileForRecords, null)
      if (isRecords(r.data) && r.source !== 'missing' && r.source !== 'defaults') { records = r.data; return records }
      let old = null
      try { old = store.get(STORE_KEY) } catch (_) {}
      records = isRecords(old) ? old : {}
      if (Object.keys(records).length) {
        try {
          safeJson.writeJsonAtomic(fileForRecords, records, { indent: 0, backup: false })
          lastFileWrite = Date.now()
          try { store.delete(STORE_KEY) } catch (_) {}
          log('intro scan: moved the detection results out of the settings file')
        } catch (e) { log(`intro scan: could not move the results to their own file (${e && e.message})`) }
      }
      return records
    }
    let raw = null
    try { raw = store.get(STORE_KEY) } catch (_) {}
    records = isRecords(raw) ? raw : {}
    return records
  }
  function saveNow() {
    if (saveTimer) { timers.clearTimeout(saveTimer); saveTimer = null }
    if (!records) return
    try {
      if (fileForRecords) { safeJson.writeJsonAtomic(fileForRecords, records, { indent: 0, backup: false }); lastFileWrite = Date.now() }
      else store.set(STORE_KEY, records)
    } catch (e) { log(`intro scan: could not save results (${e && e.message})`) }
  }
  // Between groups of a long pass: with a file, at most one write every few seconds (the timer catches the rest).
  function saveThrottled() {
    if (fileForRecords && Date.now() - lastFileWrite < 5000) { saveSoon(); return }
    saveNow()
  }
  function saveSoon() {
    if (saveTimer) return
    saveTimer = timers.setTimeout(() => { saveTimer = null; saveNow() }, 1500)
    if (saveTimer && saveTimer.unref) saveTimer.unref()
  }
  function recOf(identity) { return load()[identity] || null }
  function put(identity, patch) {
    const r = load()
    // A record from an older detector version is stale as a whole: never mix its numbers with new ones.
    const prev = currentVersion(r[identity]) ? r[identity] : {}
    r[identity] = { ...prev, ...patch }
    saveSoon()
    return r[identity]
  }
  function currentVersion(rec) { return !!rec && rec.version === detect.DETECTOR_VERSION }

  // -------------------------------------------------------------- pausing
  async function waitIdle() {
    for (;;) {
      if (stopped) return false
      if (!enabled()) { st.paused = 'disabled'; return false }
      if (!ffmpegPath()) { st.paused = 'no_ffmpeg'; return false }
      // isBusy() is false, true (someone is watching) or a reason: 'playback' | 'battery' | 'busy'.
      let busy = false
      let why = 'playback'
      try { const b = isBusy(); busy = !!b; if (typeof b === 'string') why = b } catch (_) { busy = false }
      if (!busy) { st.paused = null; return true }
      st.paused = why
      await sleep(pollMs)
    }
  }

  async function runLimited(tasks) {
    const results = new Array(tasks.length)
    let next = 0
    const lane = async () => {
      while (next < tasks.length && !stopped) {
        const i = next++
        results[i] = await tasks[i]()
      }
    }
    await Promise.all(Array.from({ length: concurrency() }, lane))
    return results
  }

  // ------------------------------------------------------------ one file
  // Whatever an injected/real helper does, one bad file must never take the pass down with it.
  const attempt = async (fn, ...args) => {
    try { return await fn(...args) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
  }

  async function durationOf(entry) {
    const rec = recOf(entry.identity)
    if (rec && rec.durationSec > 0 && currentVersion(rec)) return rec.durationSec
    if (!(await waitIdle())) return ABORTED
    let d = null
    try { d = await probe(entry.path, { ffprobePath: ffprobePath(), spawnFn, priority }) } catch (_) { d = null }
    if (pauseBetweenMs) await sleep(pauseBetweenMs)
    return d
  }

  function baseRecord(entry, extra) {
    return { identity: entry.identity, kind: entry.kind, path: entry.path, showKey: entry.showKey || null, showName: entry.showName || null, season: entry.season == null ? null : entry.season, version: detect.DETECTOR_VERSION, seenAt: now(), ...extra }
  }

  async function fingerprintOf(entry, durationSec) {
    const dir = cacheDir()
    const cached = readFp(dir, entry.identity)
    if (cached) return { ok: true, fp: cached }
    if (!(await waitIdle())) return { ok: false, error: 'paused' }
    st.current = entry.label || entry.path
    const seconds = detect.introWindowSeconds(durationSec)
    const r = await attempt(extract, entry.path, { ffmpegPath: ffmpegPath(), seconds, spawnFn, priority })
    if (pauseBetweenMs) await sleep(pauseBetweenMs)
    if (r && r.ok) writeFp(dir, entry.identity, r.fp)
    return r || { ok: false, error: 'failed' }
  }

  async function introForGroup(group, sig) {
    st.phase = 'intro'
    const ready = []
    const tasks = group.map((entry) => async () => {
      const rec = recOf(entry.identity)
      if (rec && rec.introError && rec.introRetryAt > now() && currentVersion(rec)) return
      if (rec && rec.cleared && currentVersion(rec) && rec.introDone) return
      const duration = await durationOf(entry)
      if (stopped || duration === ABORTED) return
      if (!duration) {
        put(entry.identity, baseRecord(entry, { introDone: true, introError: 'unreadable', introRetryAt: now() + RETRY_AFTER_MS, introSig: sig }))
        return
      }
      const r = await fingerprintOf(entry, duration)
      if (!r.ok) {
        if (r.error === 'paused') return
        put(entry.identity, baseRecord(entry, { durationSec: duration, introDone: true, introError: r.error || 'failed', introRetryAt: now() + RETRY_AFTER_MS, introSig: sig }))
        log(`intro scan: could not read the audio of ${entry.label || entry.path} (${r.error})`)
        return
      }
      ready.push({ id: entry.identity, fp: r.fp, entry, duration })
    })
    await runLimited(tasks)
    if (stopped) return
    // Any episode we could not get (paused/aborted) leaves the season unfinished for the next pass.
    const unfinished = group.some((e) => {
      if (ready.some((x) => x.id === e.identity)) return false
      const rec = recOf(e.identity)
      if (rec && currentVersion(rec) && rec.introDone && (rec.introSig === sig || rec.cleared || (rec.introError && rec.introRetryAt > now()))) return false
      return true
    })
    if (unfinished) return
    let results = new Map()
    try { results = ready.length >= 2 ? await detectSeason(ready.map((x) => ({ id: x.id, fp: x.fp }))) : new Map() } catch (e) { log(`intro scan: season comparison failed (${e && e.message})`) }
    for (const x of ready) {
      const existing = recOf(x.id)
      if (existing && existing.cleared && currentVersion(existing)) continue
      const res = results.get(x.id)
      const clear = { introStart: null, introEnd: null, introConfidence: 0 }
      put(x.id, baseRecord(x.entry, {
        durationSec: x.duration,
        introDone: true,
        introError: null,
        introRetryAt: null,
        introSig: sig,
        introMethod: 'audio-fingerprint',
        detectedAt: now(),
        ...(res ? { introStart: res.introStart, introEnd: res.introEnd, introConfidence: res.confidence, introSupport: res.support } : clear)
      }))
      const rec = recOf(x.id)
      rec.confidence = Math.max(rec.introConfidence || 0, rec.creditsConfidence || 0)
    }
    saveThrottled()
  }

  function needsIntro(entry, sig) {
    const rec = recOf(entry.identity)
    if (!rec || !currentVersion(rec)) return true
    if (rec.cleared && rec.introDone) return false
    if (rec.introError && rec.introRetryAt > now()) return false
    return !(rec.introDone && rec.introSig === sig)
  }

  function needsCredits(entry) {
    const rec = recOf(entry.identity)
    if (!rec || !currentVersion(rec)) return true
    if (rec.cleared && rec.creditsDone) return false
    if (rec.creditsError && rec.creditsRetryAt > now()) return false
    return !rec.creditsDone || (!!rec.creditsError && rec.creditsRetryAt <= now())
  }

  async function creditsForItem(entry) {
    st.phase = 'credits'
    const duration = await durationOf(entry)
    if (stopped || duration === ABORTED) return
    if (!duration) {
      put(entry.identity, baseRecord(entry, { creditsDone: true, creditsError: 'unreadable', creditsRetryAt: now() + RETRY_AFTER_MS }))
      return
    }
    if (!(await waitIdle())) return
    st.current = entry.label || entry.path
    const r = (await attempt(analyseTail, entry.path, { ffmpegPath: ffmpegPath(), durationSeconds: duration, keyframesOnly: !fullDecode(), spawnFn, priority })) || { ok: false, error: 'failed' }
    if (pauseBetweenMs) await sleep(pauseBetweenMs)
    if (stopped) return
    if (!r.ok) {
      put(entry.identity, baseRecord(entry, { durationSec: duration, creditsDone: true, creditsError: r.error || 'failed', creditsRetryAt: now() + RETRY_AFTER_MS }))
      log(`credits scan: could not analyse ${entry.label || entry.path} (${r.error})`)
      return
    }
    const candidates = detect.creditsCandidates({ black: r.black, silence: r.silence, durationSeconds: duration, kind: entry.kind })
    put(entry.identity, baseRecord(entry, { durationSec: duration, creditsDone: true, creditsError: null, creditsRetryAt: null, creditsCandidates: candidates, creditsMethod: 'black-silence', detectedAt: now() }))
  }

  // The season's episodes must agree on how far from the end the credits start.
  function recomputeCredits(group, kind) {
    const rows = group.map((e) => ({ e, rec: recOf(e.identity) })).filter((x) => x.rec && x.rec.creditsDone && !x.rec.creditsError)
    const consensus = detect.creditsConsensus(rows.map((x) => ({ id: x.e.identity, candidates: x.rec.creditsCandidates || [] })), { kind })
    for (const x of rows) {
      const c = consensus.get(x.e.identity)
      if (x.rec.cleared) continue
      x.rec.creditsStart = c ? c.creditsStart : null
      x.rec.creditsConfidence = c ? c.confidence : 0
      x.rec.confidence = Math.max(x.rec.introConfidence || 0, x.rec.creditsConfidence || 0)
    }
    saveSoon()
  }

  // ------------------------------------------------------------- the pass
  function groupsOf(entries) {
    const tv = new Map()
    const movies = []
    for (const e of entries) {
      if (e.kind === 'movie') { movies.push(e); continue }
      const key = `${e.showKey || ''}|${e.season == null ? 'x' : e.season}`
      if (!tv.has(key)) tv.set(key, [])
      tv.get(key).push(e)
    }
    for (const g of tv.values()) g.sort((a, b) => (a.episode || 0) - (b.episode || 0) || String(a.path).localeCompare(String(b.path)))
    return { tv: [...tv.values()], movies }
  }

  function progressCount(entries, groups) {
    let done = 0
    const sigOf = new Map()
    for (const g of groups.tv) { const sig = seasonSignature(g.map((e) => e.identity)); for (const e of g) sigOf.set(e.identity, { sig, multi: g.length >= 2 }) }
    for (const e of entries) {
      const rec = recOf(e.identity)
      if (!rec || !currentVersion(rec) || !rec.creditsDone) continue
      const s = sigOf.get(e.identity)
      if (s && s.multi && !(rec.introDone && rec.introSig === s.sig)) continue
      done++
    }
    return done
  }

  async function runPass() {
    if (running || stopped) return { ok: false, error: 'already_running' }
    if (!enabled()) { st.paused = 'disabled'; return { ok: false, error: 'disabled' } }
    if (!ffmpegPath()) { st.paused = 'no_ffmpeg'; return { ok: false, error: 'no_ffmpeg' } }
    running = true
    const t0 = now()
    let processed = 0
    try {
      let items = []
      try { items = (await listItems()) || [] } catch (e) { log(`intro scan: could not list the library (${e && e.message})`); items = [] }
      const entries = []
      let sinceYield = 0
      for (const it of items) {
        if (!it || !it.path) continue
        const stat = statFile(it.path)
        if (!stat) continue
        entries.push({ ...it, identity: model.fileIdentity(it.path, stat) })
        // A 40,000-file library is 40,000 synchronous stats; let the server answer viewers between batches.
        if (++sinceYield >= 400) { sinceYield = 0; await new Promise((resolve) => setImmediate(resolve)) }
      }
      liveIds = new Set(entries.map((e) => e.identity))
      const groups = groupsOf(entries)
      st.itemsTotal = entries.length
      st.itemsDone = progressCount(entries, groups)
      pruneRecords(entries)
      pruneFpCache(cacheDir(), now())

      // progressCount walks every entry and hashes every season, so calling it after each episode made a pass
      // quadratic in the size of the library (tens of milliseconds of blocked server per file at 40,000). The
      // number on screen only needs to move now and then; the end of the pass always has the exact figure.
      let lastCountAt = 0
      const finishedItems = (force) => {
        const t = Date.now()
        if (!force && t - lastCountAt < PROGRESS_EVERY_MS) return
        lastCountAt = t
        st.itemsDone = progressCount(entries, groups)
      }
      for (const group of groups.tv) {
        if (!(await waitIdle())) break
        const sig = seasonSignature(group.map((e) => e.identity))
        if (group.length >= 2 && group.some((e) => needsIntro(e, sig))) {
          await introForGroup(group, sig)
          processed++
        }
        for (const e of group) {
          if (stopped || !(await waitIdle())) break
          if (!needsCredits(e)) continue
          await creditsForItem(e)
          processed++
          recomputeCredits(group, 'tv')
          finishedItems()
        }
        recomputeCredits(group, 'tv')
        finishedItems()
        saveThrottled()
      }
      for (const e of groups.movies) {
        if (!(await waitIdle())) break
        if (!needsCredits(e)) continue
        await creditsForItem(e)
        processed++
        recomputeCredits([e], 'movie')
        finishedItems()
      }
      saveNow()
      finishedItems(true)
      st.lastError = ''
      return { ok: true, processed }
    } catch (e) {
      st.lastError = String((e && e.message) || e)
      log(`intro scan: pass stopped by an unexpected error (${st.lastError})`)
      saveNow()
      return { ok: false, error: st.lastError }
    } finally {
      running = false
      st.phase = 'idle'
      st.current = ''
      st.passes++
      st.lastPassAt = now()
      st.lastPassMs = now() - t0
      if (rerun && !stopped) { rerun = false; setImmediate(() => { runPass().catch(() => {}) }) }
      try { store.set(STATE_KEY, { lastPassAt: st.lastPassAt, lastPassMs: st.lastPassMs, itemsTotal: st.itemsTotal, itemsDone: st.itemsDone }) } catch (_) {}
    }
  }

  function pruneRecords(entries) {
    const r = load()
    const seenAt = now()
    let changed = false
    for (const e of entries) { const rec = r[e.identity]; if (rec && seenAt - (rec.seenAt || 0) > DAY) { rec.seenAt = seenAt; changed = true } }
    for (const [k, rec] of Object.entries(r)) {
      if (liveIds.has(k)) continue
      if (seenAt - ((rec && rec.seenAt) || 0) > PRUNE_AFTER_MS) { delete r[k]; changed = true }
    }
    if (changed) saveSoon()
  }

  // ---------------------------------------------------------------- API
  function start() {
    stopped = false
    if (firstTimer || repeatTimer) return
    firstTimer = timers.setTimeout(() => { firstTimer = null; runPass().catch(() => {}) }, startDelayMs)
    if (firstTimer && firstTimer.unref) firstTimer.unref()
    repeatTimer = timers.setInterval(() => { runPass().catch(() => {}) }, intervalMs)
    if (repeatTimer && repeatTimer.unref) repeatTimer.unref()
  }

  function stop() {
    stopped = true
    if (firstTimer) { timers.clearTimeout(firstTimer); firstTimer = null }
    if (repeatTimer) { timers.clearInterval(repeatTimer); repeatTimer = null }
    saveNow()
  }

  // Asked for while a pass is already running (a re-scan pressed mid-way): run once more right after
  // it, so results deleted behind the pass's back are not left until the next interval.
  function kick() {
    if (stopped) return Promise.resolve({ ok: false, error: 'stopped' })
    if (running) { rerun = true; return Promise.resolve({ ok: false, error: 'already_running' }) }
    return runPass()
  }

  // What was found for this file (or null). Never touches the disk beyond one stat.
  function lookup(filePath) {
    const stat = statFile(filePath)
    if (!stat) return null
    return recOf(model.fileIdentity(filePath, stat))
  }

  // Before the first pass has listed the library every stored record counts; afterwards only files that
  // are still there (records of vanished files linger until the 90-day prune).
  function isLive(r) { return !!r && (liveIds.size === 0 || liveIds.has(r.identity)) }

  function recordsForShow(showKey) {
    return Object.values(load()).filter((r) => r && r.showKey === showKey)
  }

  // Forget what was auto-detected for a show and don't guess again until a re-scan (or a changed
  // file). Keeps the "already looked" flags so the scanner does not immediately redo it.
  function clearShow(showKey) {
    let n = 0
    for (const r of recordsForShow(showKey)) {
      r.introStart = null; r.introEnd = null; r.introConfidence = 0
      r.creditsStart = null; r.creditsConfidence = 0; r.confidence = 0
      r.cleared = true
      n++
    }
    saveNow()
    return { ok: true, cleared: n }
  }

  // Throw away the show's results AND its cached fingerprints so the next pass redoes it from scratch.
  function rescanShow(showKey) {
    const r = load()
    let n = 0
    for (const [k, rec] of Object.entries(r)) {
      if (rec && rec.showKey === showKey) { dropFp(cacheDir(), k); delete r[k]; n++ }
    }
    saveNow()
    kick().catch(() => {})
    return { ok: true, reset: n }
  }

  function rescanFile(filePath) {
    const stat = statFile(filePath)
    if (!stat) return { ok: false, error: 'not_found' }
    const id = model.fileIdentity(filePath, stat)
    const r = load()
    const existed = !!r[id]
    dropFp(cacheDir(), id)
    delete r[id]
    saveNow()
    kick().catch(() => {})
    return { ok: true, reset: existed ? 1 : 0 }
  }

  function clearFile(filePath) {
    const stat = statFile(filePath)
    if (!stat) return { ok: false, error: 'not_found' }
    const rec = recOf(model.fileIdentity(filePath, stat))
    if (!rec) return { ok: true, cleared: 0 }
    rec.introStart = null; rec.introEnd = null; rec.introConfidence = 0
    rec.creditsStart = null; rec.creditsConfidence = 0; rec.confidence = 0
    rec.cleared = true
    saveNow()
    return { ok: true, cleared: 1 }
  }

  // One row per show (plus one for films) for the admin list: how many of its files got what.
  function summary() {
    const shows = new Map()
    let movies = { count: 0, credits: 0 }
    for (const r of Object.values(load())) {
      if (!isLive(r)) continue
      const g = model.guardAutoRecord(r, null)
      if (r.kind === 'movie') {
        movies.count++
        if (g.creditsStartSeconds !== null) movies.credits++
        continue
      }
      const key = r.showKey || ''
      if (!key) continue
      if (!shows.has(key)) shows.set(key, { scope: 'show', key, name: r.showName || key, episodes: 0, intro: 0, credits: 0 })
      const row = shows.get(key)
      row.episodes++
      if (g.introEndSeconds !== null) row.intro++
      if (g.creditsStartSeconds !== null) row.credits++
    }
    const list = [...shows.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    if (movies.count) list.push({ scope: 'movies', key: '', name: 'Films', episodes: movies.count, intro: 0, credits: movies.credits })
    return list
  }

  function status() {
    let intro = 0, credits = 0
    for (const r of Object.values(load())) {
      if (!isLive(r)) continue
      const g = model.guardAutoRecord(r, null)
      if (g.introEndSeconds !== null) intro++
      if (g.creditsStartSeconds !== null) credits++
    }
    return {
      enabled: enabled(),
      running,
      paused: st.paused,
      phase: st.phase,
      current: st.current,
      itemsTotal: st.itemsTotal,
      itemsDone: st.itemsDone,
      introFound: intro,
      creditsFound: credits,
      lastPassAt: st.lastPassAt,
      lastPassMs: st.lastPassMs,
      lastError: st.lastError
    }
  }

  return { start, stop, kick, runPass, lookup, clearShow, rescanShow, rescanFile, clearFile, summary, status, flush: saveNow, _records: load, _state: st }
}

module.exports = {
  STORE_KEY,
  STATE_KEY,
  ENABLED_KEY,
  RETRY_AFTER_MS,
  seasonSignature,
  writeFp,
  readFp,
  createIntroScanner
}
