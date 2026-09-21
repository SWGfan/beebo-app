'use strict'
// ============================================================================
// speechPack/jobs.js - the subtitle-generation queue (the Speech Pack's background job).
// ----------------------------------------------------------------------------
// Pattern borrowed from introDetectJob.js, tightened for a much heavier task:
//   * LOCAL ONLY. ffmpeg (already bundled) cuts the audio into 16 kHz mono chunks in a private
//     work folder; whisper.cpp (the Speech Pack engine) transcribes each chunk; the pieces are
//     stitched into "<video>.<lang>.ai.srt". No network call is made anywhere in this file.
//   * ONE job at a time, at low priority, using about half the CPU threads.
//   * POLITE. Before every chunk it waits while anyone is watching, a live conversion or the
//     converter queue is running, or (by default) the PC is on battery; and if that starts while
//     a chunk is being transcribed, the chunk is stopped and redone later. Chunks are 5 minutes
//     of audio, so at most a few minutes of work is ever thrown away.
//   * RESUMABLE. After each chunk the segments so far go to <addon data>/work/<job>.json, so a
//     restart, a pause of hours or a crash continues at the next chunk. The video's identity
//     (path|size|mtime) is checked - an edited file starts over.
//   * SAFE. Jobs are created from a (kind, id) the library itself listed - never from a path a
//     caller sent. Output is written atomically next to the video; nothing existing is
//     overwritten unless the owner asked. Logs carry job ids and counts, never titles or text.
// Persisted in the settings store: 'aiSubtitleJobs' (the queue), 'aiSubtitleAttempts' (which files
// were already tried, so a failure is not retried every half hour), 'aiSubtitleLibraries' (the
// per-library "auto-generate when no subtitles exist" switches, default OFF).
// ============================================================================

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const whisper = require('./whisper')
const srt = require('./srt')
const aiSubtitles = require('../../aiSubtitles')
const { renameSyncRetry } = require('../fsRetry')
const { ADDON_ID, MODELS } = require('./manifest')

const JOBS_KEY = 'aiSubtitleJobs'
const ATTEMPTS_KEY = 'aiSubtitleAttempts'
const LIBRARIES_KEY = 'aiSubtitleLibraries'
const CHECKED_KEY = 'aiSubtitleChecked'
const SETTING_KEYS = {
  model: 'aiSubtitlesModel',
  language: 'aiSubtitlesLanguage',
  translate: 'aiSubtitlesTranslate',
  pauseOnBattery: 'aiSubtitlesPauseOnBattery',
  threads: 'aiSubtitlesThreads'
}
const DAY = 24 * 60 * 60 * 1000
const RETRY_FAILED_AFTER_MS = 7 * DAY
const RECHECK_HAS_SUBS_AFTER_MS = 14 * DAY
const MAX_JOBS = 300
const MAX_AUTO_PER_SCAN = 25
const MAX_PROBES_PER_SCAN = 400
const MODEL_PREFERENCE = ['base.en', 'base', 'small.en', 'small', 'tiny.en', 'tiny']

const ACTIVE = new Set(['queued', 'running'])
const modelInfo = (key) => MODELS.find((m) => m.key === key) || null
const dirKey = (p) => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r }

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref() })

function createSubtitleQueue({
  store,
  addons,                      // the add-on manager (resolve / isInstalled / dataDir / on)
  listItems,                   // () => [{ kind, id, path, label, dir }]
  libraries = () => [],        // () => [{ dir, kind: 'movies'|'tv' }]
  hasSubtitles = async () => false, // async (videoPath) => true when any subtitle (file or embedded text) exists
  isBusy = () => false,        // true while playback / live conversion / converter is working
  onBattery = () => false,
  ffmpegPath = () => null,
  ffprobePath = () => null,
  log = () => {},
  now = () => Date.now(),
  sleep = defaultSleep,
  statFile = (p) => { try { const s = fs.statSync(p); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null } catch { return null } },
  spawnFn,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  chunkSeconds = 300,
  overlapSeconds = 2,
  pollMs = 15000,
  startDelayMs = 5 * 60 * 1000,
  scanIntervalMs = 30 * 60 * 1000,
  onDone = () => {},
  probe = whisper.probeDuration,
  extractChunk = whisper.extractChunk,
  transcribeChunk = whisper.transcribeChunk,
  detectLanguage = whisper.detectLanguage
} = {}) {
  let jobs = null
  let stopped = false
  let pumping = null
  let current = null // { id, abort: AbortController }
  let scanTimer = null
  let firstTimer = null
  let pauseReason = null
  let pumpRequested = false
  let uninstalling = false // an uninstall of the pack is in progress: do not start anything that would hold its files

  const get = (k, d) => { try { const v = store.get(k); return v === undefined || v === null || v === '' ? d : v } catch { return d } }
  const put = (k, v) => { try { store.set(k, v) } catch (e) { log(`speech pack: could not save ${k} (${e && e.message})`) } }

  // ---------------------------------------------------------------- settings
  function getSettings() {
    return {
      model: String(get(SETTING_KEYS.model, '')),
      language: String(get(SETTING_KEYS.language, 'auto')),
      translate: get(SETTING_KEYS.translate, false) === true,
      pauseOnBattery: get(SETTING_KEYS.pauseOnBattery, true) !== false,
      threads: Math.max(0, Math.min(16, Math.trunc(Number(get(SETTING_KEYS.threads, 0))) || 0))
    }
  }
  function setSettings(patch = {}) {
    if (typeof patch.model === 'string') put(SETTING_KEYS.model, patch.model === '' || modelInfo(patch.model) ? patch.model : '')
    if (typeof patch.language === 'string') put(SETTING_KEYS.language, patch.language === 'auto' || aiSubtitles.isSafeLanguageCode(patch.language) ? patch.language : 'auto')
    if (typeof patch.translate === 'boolean') put(SETTING_KEYS.translate, patch.translate)
    if (typeof patch.pauseOnBattery === 'boolean') put(SETTING_KEYS.pauseOnBattery, patch.pauseOnBattery)
    if (patch.threads !== undefined) put(SETTING_KEYS.threads, Math.max(0, Math.min(16, Math.trunc(Number(patch.threads)) || 0)))
    return getSettings()
  }

  function installedModels() {
    return MODELS.filter((m) => { try { return addons.isInstalled(ADDON_ID, `model-${m.key}`) } catch { return false } }).map((m) => m.key)
  }
  function engineInstalled() { try { return addons.isInstalled(ADDON_ID, 'engine') } catch { return false } }
  function chooseModel(requested) {
    const have = installedModels()
    if (requested && have.includes(requested)) return requested
    const pref = getSettings().model
    if (pref && have.includes(pref)) return pref
    return MODEL_PREFERENCE.find((k) => have.includes(k)) || null
  }

  // -------------------------------------------------------------------- jobs
  function load() {
    if (jobs) return jobs
    const raw = get(JOBS_KEY, [])
    jobs = Array.isArray(raw) ? raw.filter((j) => j && typeof j.id === 'string') : []
    // A job that was mid-way when the app closed simply continues from its saved chunk.
    for (const j of jobs) if (j.status === 'running') j.status = 'queued'
    return jobs
  }
  let saveTimer = null
  function save() {
    if (saveTimer) { timers.clearTimeout(saveTimer); saveTimer = null }
    const list = load()
    if (list.length > MAX_JOBS) {
      const finished = list.filter((j) => !ACTIVE.has(j.status)).sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0))
      for (const j of finished.slice(0, list.length - MAX_JOBS)) list.splice(list.indexOf(j), 1)
    }
    put(JOBS_KEY, list)
  }
  const jobById = (id) => load().find((j) => j.id === id) || null
  const newId = () => 'j' + now().toString(36) + crypto.randomBytes(3).toString('hex')

  function publicJob(j) {
    const p = j.progress || { chunksDone: 0, chunksTotal: 0 }
    return {
      id: j.id, kind: j.kind, label: j.label, status: j.status, auto: !!j.auto,
      model: j.model, language: j.language, translate: !!j.translate,
      detectedLanguage: j.detectedLanguage || null, outputLanguage: j.outputLanguage || null,
      percent: p.chunksTotal ? Math.floor((p.chunksDone / p.chunksTotal) * 100) : (j.status === 'done' ? 100 : 0),
      chunksDone: p.chunksDone, chunksTotal: p.chunksTotal,
      paused: j.status === 'running' && current && current.id === j.id ? pauseReason : null,
      error: j.error || null, message: j.message || null, outFile: j.outFile || null,
      createdAt: j.createdAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null
    }
  }

  // ------------------------------------------------------------- work files
  function workDir() { const d = path.join(addons.dataDir(ADDON_ID), 'work'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d }
  const workFile = (id) => path.join(workDir(), `${id}.json`)
  function readWork(id) {
    try { const w = JSON.parse(fs.readFileSync(workFile(id), 'utf8')); return w && typeof w === 'object' ? w : null } catch { return null }
  }
  function writeWork(id, w) {
    const f = workFile(id)
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(w), { mode: 0o600 })
    renameSyncRetry(tmp, f)
  }
  function dropWork(id) {
    try { fs.rmSync(workFile(id), { force: true }) } catch {}
    try { fs.rmSync(path.join(workDir(), id), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  }

  // -------------------------------------------------------------- pausing
  function currentPauseReason() {
    if (!engineInstalled()) return 'not_installed'
    // isBusy() may answer true, or a reason string ('playback' | 'battery' | 'busy') from backgroundGate.js.
    let busy = false
    try { busy = isBusy() } catch { busy = false }
    if (busy) return typeof busy === 'string' ? busy : 'playback'
    let battery = false
    try { battery = !!onBattery() } catch { battery = false }
    if (battery && getSettings().pauseOnBattery) return 'battery'
    return null
  }

  async function waitIdle(job) {
    for (;;) {
      if (stopped || job.status !== 'running') return false
      const reason = currentPauseReason()
      pauseReason = reason
      if (!reason) return true
      await sleep(pollMs)
    }
  }

  // ------------------------------------------------------------ one job
  const fail = (job, error, message) => {
    job.status = 'failed'; job.error = error; job.message = message || null; job.finishedAt = now()
    recordAttempt(job, 'failed')
    dropWork(job.id)
    save()
    log(`speech pack: job ${job.id} failed (${error})`)
  }

  function recordAttempt(job, status) {
    if (!job.identity) return
    const a = get(ATTEMPTS_KEY, {})
    const map = a && typeof a === 'object' && !Array.isArray(a) ? a : {}
    map[job.identity] = { at: now(), status }
    const keys = Object.keys(map)
    if (keys.length > 3000) for (const k of keys.sort((x, y) => map[x].at - map[y].at).slice(0, keys.length - 3000)) delete map[k]
    put(ATTEMPTS_KEY, map)
  }

  const identityOf = (p, st) => `${p}|${st.size}|${st.mtimeMs}`

  async function processJob(job) {
    // -- the tools and the model
    let engine
    let modelPath
    const modelKey = chooseModel(job.model)
    if (!modelKey) return fail(job, 'model_missing', 'No speech model is installed.')
    job.model = modelKey
    try {
      engine = await addons.resolve(ADDON_ID, 'engine')
      modelPath = (await addons.resolve(ADDON_ID, `model-${modelKey}`)).file
    } catch (e) {
      return fail(job, e && e.code === 'corrupt' ? 'corrupt' : 'not_installed', e && e.message)
    }
    const minfo = modelInfo(modelKey)
    const ffmpeg = ffmpegPath()
    if (!ffmpeg) return fail(job, 'no_ffmpeg', 'ffmpeg is not available.')

    // -- the video (looked up again: the file may have moved since it was queued)
    const item = (await Promise.resolve(listItems())).find((i) => i && i.kind === job.kind && i.id === job.itemId)
    if (!item) return fail(job, 'not_found', 'The title is no longer in the library.')
    const st = statFile(item.path)
    if (!st) return fail(job, 'not_found', 'The video file is missing.')
    const identity = identityOf(item.path, st)
    let work = readWork(job.id)
    if (job.identity && job.identity !== identity) { work = null; job.progress = { chunksDone: 0, chunksTotal: 0 } }
    job.identity = identity

    if (!(work && work.durationSec) && !(await waitIdle(job))) return 'interrupted' // even ffprobe waits for a quiet house
    const duration = work && work.durationSec ? work.durationSec : await probe(item.path, { ffprobePath: ffprobePath(), spawnFn, priority: true })
    if (!duration) return fail(job, 'unreadable', 'The video could not be read.')
    if (!work) work = { identity, durationSec: duration, chunksDone: 0, language: null, segments: [] }

    const cwd = path.join(workDir(), job.id)
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
    const threads = getSettings().threads || whisper.defaultThreads()
    const wav = path.join(cwd, 'chunk.wav')
    const outPrefix = path.join(cwd, 'chunk')
    const ctl = current.abort

    // -- language
    let language = work.language
    if (!language) {
      if (minfo.english) {
        if (job.language !== 'auto' && job.language !== 'en') return fail(job, 'english_model_only', 'This model only understands English. Pick a many-languages model.')
        language = 'en'
      } else if (job.language !== 'auto') {
        language = job.language
      } else {
        // Listen to two 30-second samples (a quarter and half way in) and trust the surer one.
        let best = null
        for (const frac of [0.25, 0.5]) {
          if (!(await waitIdle(job))) return 'interrupted'
          const start = Math.max(0, Math.min(duration - 30, duration * frac))
          const ex = await extractChunk({ ffmpegPath: ffmpeg, input: item.path, start, duration: 30, out: wav, signal: ctl.signal, spawnFn })
          if (!ex.ok) { if (ex.error === 'cancelled') return 'interrupted'; return fail(job, ex.error === 'no_audio' ? 'no_audio' : 'audio_failed', 'The audio could not be read.') }
          const d = await detectLanguage({ whisperExe: engine.file, modelPath, wavPath: wav, threads, signal: ctl.signal, spawnFn, cwd })
          try { fs.rmSync(wav, { force: true }) } catch {}
          if (d && (!best || d.probability > best.probability)) best = d
          if (best && best.probability >= 0.85) break
        }
        language = best && aiSubtitles.isSafeLanguageCode(best.language) ? best.language : 'en'
      }
      work.language = language
      writeWork(job.id, work)
    }
    const translate = !!job.translate && !minfo.english && language !== 'en'
    const outLang = job.translate && !minfo.english ? 'en' : language
    job.detectedLanguage = language
    job.outputLanguage = outLang

    let outFile
    try { outFile = aiSubtitles.aiSidecarPath(item.path, outLang) } catch { return fail(job, 'bad_language', 'That language cannot be used.') }
    if (fs.existsSync(outFile) && !job.overwrite) {
      job.status = 'done'; job.message = 'An AI subtitle file already exists.'; job.outFile = path.basename(outFile); job.finishedAt = now()
      dropWork(job.id); save()
      return 'done'
    }

    // -- the chunks
    const total = Math.max(1, Math.ceil(duration / chunkSeconds))
    job.progress = { chunksDone: work.chunksDone, chunksTotal: total }
    save()
    let failures = 0
    while (work.chunksDone < total) {
      if (!(await waitIdle(job))) return 'interrupted'
      const i = work.chunksDone
      const start = i * chunkSeconds
      const len = Math.min(chunkSeconds + overlapSeconds, duration - start)
      const ex = await extractChunk({ ffmpegPath: ffmpeg, input: item.path, start, duration: len, out: wav, signal: ctl.signal, spawnFn })
      if (!ex.ok) {
        if (ex.error === 'cancelled') return 'interrupted'
        return fail(job, ex.error === 'no_audio' ? 'no_audio' : 'audio_failed', ex.error === 'no_audio' ? 'The video has no audio track.' : 'The audio could not be read.')
      }
      // Stop this chunk if someone starts watching while it runs.
      const chunkCtl = new AbortController()
      let interrupted = false
      const onOuter = () => chunkCtl.abort()
      ctl.signal.addEventListener('abort', onOuter, { once: true })
      const watch = timers.setInterval(() => {
        const r = currentPauseReason()
        if (r && r !== 'not_installed') { interrupted = true; pauseReason = r; chunkCtl.abort() }
      }, Math.max(50, Math.min(pollMs, 5000)))
      if (watch && watch.unref) watch.unref()
      let res
      try {
        res = await transcribeChunk({ whisperExe: engine.file, modelPath, wavPath: wav, outPrefix, language, translate, threads, signal: chunkCtl.signal, spawnFn, cwd, readFile: (f) => fs.readFileSync(f, 'utf8') })
      } finally {
        timers.clearInterval(watch)
        ctl.signal.removeEventListener('abort', onOuter)
        for (const f of [wav, outPrefix + '.json']) { try { fs.rmSync(f, { force: true }) } catch {} }
      }
      if (job.status !== 'running' || stopped) return 'interrupted'
      if (!res.ok) {
        if (res.error === 'cancelled' && interrupted) continue // paused mid-chunk: redo it when the house is quiet
        if (res.error === 'cancelled') return 'interrupted'
        if (++failures >= 2) return fail(job, res.error, 'The speech engine could not process the audio.')
        continue
      }
      failures = 0
      const isLast = i === total - 1
      for (const s of res.segments) {
        const absStart = start + s.start
        if (!isLast && absStart >= start + chunkSeconds) continue // belongs to the next chunk
        work.segments.push({ start: absStart, end: start + s.end, text: s.text })
      }
      work.chunksDone = i + 1
      writeWork(job.id, work)
      job.progress = { chunksDone: work.chunksDone, chunksTotal: total }
      save()
    }

    // -- the file
    const text = srt.segmentsToSrt(work.segments)
    if (!text.trim()) return fail(job, 'no_speech', 'No speech was found.')
    try {
      const tmp = path.join(path.dirname(outFile), `.${path.basename(outFile)}.${crypto.randomBytes(3).toString('hex')}.tmp`)
      fs.writeFileSync(tmp, text, { encoding: 'utf8' })
      renameSyncRetry(tmp, outFile)
    } catch (e) {
      return fail(job, 'cannot_write', 'The subtitle file could not be saved next to the video (is the folder read-only?).')
    }
    job.status = 'done'; job.outFile = path.basename(outFile); job.finishedAt = now(); job.error = null; job.message = null
    recordAttempt(job, 'done')
    dropWork(job.id)
    save()
    log(`speech pack: job ${job.id} finished`)
    try { onDone(publicJob(job)) } catch {}
    return 'done'
  }

  // ---------------------------------------------------------------- pump
  async function pump() {
    if (pumping) { pumpRequested = true; return pumping }
    pumping = (async () => {
      try {
        for (;;) {
          if (stopped || uninstalling || !engineInstalled()) break // queued jobs wait for the pack to be (re)installed
          const job = load().find((j) => j.status === 'queued')
          if (!job) break
          job.status = 'running'; job.startedAt = job.startedAt || now(); job.error = null
          current = { id: job.id, abort: new AbortController() }
          save()
          try {
            const r = await processJob(job)
            if (r === 'interrupted' && job.status === 'running') { job.status = 'queued'; save() } // stop() mid-job: continue after restart
          } catch (e) {
            fail(job, 'unexpected', 'Something went wrong.')
            log(`speech pack: job ${job.id} crashed (${e && e.message})`)
          } finally {
            current = null
            pauseReason = null
          }
          if (stopped) break
        }
      } finally {
        pumping = null
        if (pumpRequested && !stopped) { pumpRequested = false; setImmediate(() => { pump().catch(() => {}) }) }
      }
    })()
    return pumping
  }

  // ------------------------------------------------------------------ API
  function findItem(kind, id) {
    return Promise.resolve(listItems()).then((items) => (items || []).find((i) => i && i.kind === kind && i.id === id) || null)
  }

  /**
   * enqueue({ kind, id, language, translate, model, overwrite, auto })
   * `kind`+`id` must be an item the library lists (never a path).
   */
  async function enqueue({ kind, id, language, translate, model, overwrite = false, auto = false } = {}) {
    if (!engineInstalled()) return { ok: false, error: 'not_installed', message: 'Install the Speech Pack first (Settings > Add-ons).' }
    if (!installedModels().length) return { ok: false, error: 'model_missing', message: 'Download at least one speech model first.' }
    const item = await findItem(String(kind), String(id))
    if (!item) return { ok: false, error: 'not_found', message: 'That title is not in the library.' }
    const st = statFile(item.path)
    if (!st) return { ok: false, error: 'not_found', message: 'The video file is missing.' }
    const s = getSettings()
    const lang = language ? String(language).toLowerCase() : s.language
    if (lang !== 'auto' && !aiSubtitles.isSafeLanguageCode(lang)) return { ok: false, error: 'bad_language', message: 'Unknown language.' }
    const identity = identityOf(item.path, st)
    const dup = load().find((j) => ACTIVE.has(j.status) && j.itemKey === `${item.kind}:${item.id}`)
    if (dup) return { ok: true, job: publicJob(dup), duplicate: true }
    const chosen = chooseModel(model ? String(model) : '')
    if (model && chosen !== String(model)) return { ok: false, error: 'model_missing', message: 'That model is not installed.' }
    const job = {
      id: newId(), kind: item.kind, itemId: item.id, itemKey: `${item.kind}:${item.id}`, label: String(item.label || '').slice(0, 200),
      identity, model: chosen, language: lang, translate: translate === undefined ? s.translate : !!translate,
      overwrite: !!overwrite, auto: !!auto, status: 'queued', progress: { chunksDone: 0, chunksTotal: 0 }, createdAt: now()
    }
    load().push(job)
    save()
    if (!stopped) setImmediate(() => { pump().catch(() => {}) })
    return { ok: true, job: publicJob(job) }
  }

  function cancel(id) {
    const job = jobById(String(id))
    if (!job) return { ok: false, error: 'not_found' }
    if (!ACTIVE.has(job.status)) return { ok: false, error: 'not_active' }
    job.status = 'cancelled'; job.finishedAt = now()
    if (current && current.id === job.id) { try { current.abort.abort() } catch {} }
    dropWork(job.id)
    save()
    return { ok: true }
  }
  function cancelAll() {
    let n = 0
    for (const j of load().filter((x) => ACTIVE.has(x.status))) { if (cancel(j.id).ok) n++ }
    return { ok: true, cancelled: n }
  }
  function retry(id) {
    const job = jobById(String(id))
    if (!job) return { ok: false, error: 'not_found' }
    if (ACTIVE.has(job.status)) return { ok: false, error: 'already_active' }
    job.status = 'queued'; job.error = null; job.message = null; job.finishedAt = null; job.progress = { chunksDone: 0, chunksTotal: 0 }
    save()
    if (!stopped) setImmediate(() => { pump().catch(() => {}) })
    return { ok: true }
  }
  function remove(id) {
    const list = load()
    const job = jobById(String(id))
    if (!job) return { ok: false, error: 'not_found' }
    if (ACTIVE.has(job.status)) return { ok: false, error: 'still_active' }
    list.splice(list.indexOf(job), 1)
    save()
    return { ok: true }
  }
  function clearFinished() {
    const list = load()
    const keep = list.filter((j) => ACTIVE.has(j.status))
    const n = list.length - keep.length
    list.length = 0
    list.push(...keep)
    save()
    return { ok: true, removed: n }
  }

  // --------------------------------------------------------- libraries
  function libraryList() {
    const on = get(LIBRARIES_KEY, {})
    const map = on && typeof on === 'object' ? on : {}
    const seen = new Set()
    const out = []
    for (const l of libraries() || []) {
      if (!l || !l.dir) continue
      const k = dirKey(l.dir)
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ dir: l.dir, kind: l.kind, enabled: map[k] === true })
    }
    return out
  }
  function setLibrary(dir, enabled) {
    const known = libraryList().find((l) => dirKey(l.dir) === dirKey(dir))
    if (!known) return { ok: false, error: 'unknown_library' }
    const map = { ...(get(LIBRARIES_KEY, {}) || {}) }
    if (enabled) map[dirKey(dir)] = true; else delete map[dirKey(dir)]
    put(LIBRARIES_KEY, map)
    return { ok: true, libraries: libraryList() }
  }

  // ----------------------------------------------------------- auto scan
  async function scanNow() {
    if (stopped) return { ok: false, error: 'stopped' }
    if (!engineInstalled() || !installedModels().length) return { ok: false, error: 'not_installed' }
    const enabled = new Set(libraryList().filter((l) => l.enabled).map((l) => dirKey(l.dir)))
    if (!enabled.size) return { ok: true, queued: 0, examined: 0 }
    const attempts = get(ATTEMPTS_KEY, {}) || {}
    const checked = { ...(get(CHECKED_KEY, {}) || {}) }
    let queued = 0
    let examined = 0
    for (const item of (await Promise.resolve(listItems())) || []) {
      if (stopped || queued >= MAX_AUTO_PER_SCAN || examined >= MAX_PROBES_PER_SCAN) break
      if (!item || !item.path || !item.dir || !enabled.has(dirKey(item.dir))) continue
      const st = statFile(item.path)
      if (!st) continue
      const identity = identityOf(item.path, st)
      const tried = attempts[identity]
      if (tried && tried.status === 'failed' && now() - tried.at < RETRY_FAILED_AFTER_MS) continue
      if (tried && tried.status === 'done') continue
      if (checked[identity] && now() - checked[identity] < RECHECK_HAS_SUBS_AFTER_MS) continue
      if (load().some((j) => j.itemKey === `${item.kind}:${item.id}` && (ACTIVE.has(j.status) || j.status === 'done'))) continue
      if (currentPauseReason()) break // watching / battery / busy CPU: probing files would compete
      examined++
      let has = false
      try { has = !!(await hasSubtitles(item.path)) } catch { has = true } // when unsure, do not generate
      if (has) { checked[identity] = now(); continue }
      const r = await enqueue({ kind: item.kind, id: item.id, auto: true })
      if (r.ok && !r.duplicate) queued++
    }
    const keys = Object.keys(checked)
    if (keys.length > 5000) for (const k of keys.sort((a, b) => checked[a] - checked[b]).slice(0, keys.length - 5000)) delete checked[k]
    put(CHECKED_KEY, checked)
    return { ok: true, queued, examined }
  }

  // ---------------------------------------------------------- title search
  async function search(query, limit = 25) {
    const q = String(query || '').trim().toLowerCase()
    if (q.length < 2) return []
    const out = []
    for (const i of (await Promise.resolve(listItems())) || []) {
      if (out.length >= limit) break
      if (i && String(i.label || '').toLowerCase().includes(q)) out.push({ kind: i.kind, id: i.id, label: i.label })
    }
    return out
  }

  // --------------------------------------------------------------- status
  function status() {
    const list = load().slice().sort((a, b) => b.createdAt - a.createdAt)
    return {
      installed: engineInstalled(),
      models: installedModels(),
      paused: pauseReason,
      running: !!current,
      settings: getSettings(),
      libraries: libraryList(),
      jobs: list.map(publicJob)
    }
  }

  function start() {
    stopped = false
    load()
    if (firstTimer || scanTimer) return
    // Anything left queued from last time carries on soon after start-up.
    firstTimer = timers.setTimeout(() => {
      firstTimer = null
      pump().catch(() => {})
      scanNow().catch(() => {})
    }, startDelayMs)
    if (firstTimer && firstTimer.unref) firstTimer.unref()
    scanTimer = timers.setInterval(() => { scanNow().catch(() => {}) }, scanIntervalMs)
    if (scanTimer && scanTimer.unref) scanTimer.unref()
  }

  function stop() {
    stopped = true
    if (firstTimer) { timers.clearTimeout(firstTimer); firstTimer = null }
    if (scanTimer) { timers.clearInterval(scanTimer); scanTimer = null }
    if (current) { try { current.abort.abort() } catch {} }
    if (jobs) save()
  }

  // A finished install wakes up jobs that were waiting for the pack.
  if (addons && typeof addons.on === 'function') {
    addons.on('progress', (ev) => { if (ev && ev.id === ADDON_ID && ev.phase === 'done' && !stopped) pump().catch(() => {}) })
  }
  // Uninstalling the engine or a model stops whatever is using it, and holds the queue until the files are gone.
  if (addons && typeof addons.on === 'function') {
    addons.on('uninstalled', (ev) => { if (ev && ev.id === ADDON_ID) { uninstalling = false; if (!stopped) pump().catch(() => {}) } })
  }
  if (addons && typeof addons.onBeforeUninstall === 'function') {
    addons.onBeforeUninstall(async (id) => {
      if (id !== ADDON_ID) return
      uninstalling = true
      if (current) { try { current.abort.abort() } catch {} }
      const p = pumping
      if (p) { await Promise.race([p, new Promise((r) => setTimeout(r, 5000).unref())]) }
    })
  }

  return {
    start, stop, enqueue, cancel, cancelAll, retry, remove, clearFinished, status, scanNow, search,
    getSettings, setSettings, libraryList, setLibrary, pump,
    // Resolves once nothing is queued and nothing is running (tests; bounded so it can never hang).
    idle: async () => {
      for (let i = 0; i < 5000; i++) {
        if (pumping) await pumping
        else if (!load().some((j) => j.status === 'queued') || stopped) return
        else await new Promise((r) => setImmediate(r))
      }
    },
    _jobs: load
  }
}

module.exports = { createSubtitleQueue, JOBS_KEY, ATTEMPTS_KEY, LIBRARIES_KEY, SETTING_KEYS, MODEL_PREFERENCE }
