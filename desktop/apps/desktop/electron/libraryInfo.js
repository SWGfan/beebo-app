'use strict'
// ============================================================================
// libraryInfo.js - what is inside each video file, for the Movies / TV Shows Table view.
// ----------------------------------------------------------------------------
// The library scan knows a file's name, size and modified time. Everything else the table
// can show (real width x height, codecs, HDR, runtime, bitrate, audio and subtitle
// languages, when the file was created) is read here, one ffprobe per file, and:
//
//   * READ LAZILY. The table asks only for the rows on screen (and, when it is sorted by
//     one of these columns, for the rest). Opening the table costs a stat per row shown.
//   * BOUNDED. At most `concurrency` ffprobe processes at once (3), started at
//     below-normal priority, so a thousand-film library never launches a thousand probes
//     and never competes with a video being watched.
//   * LATEST REQUEST WINS. Each screen ("scope") has one queue. Asking again replaces what
//     was still waiting, so scrolling fast does not leave a backlog of rows nobody sees.
//   * REMEMBERED. Results are saved to one JSON file keyed by path | size | modified time
//     (the same key photoLibrary.js uses for photo metadata), so a file that is replaced at
//     the same path is read again and everything else is instant on the next launch.
//     Failures are remembered for the session only, so a fixed file is retried next launch.
//
// Nothing here is exposed over HTTP: the phone and website never see these records, and
// the paths never leave the desktop window.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const tracks = require('./playbackTracks')
const classify = require('./mediaClassify')

// 2: HDR type is now precise (HDR10+, Dolby Vision profile), audio carries Atmos / DTS:X, and every record has badges.
const CACHE_VERSION = 2
const MAX_ENTRIES = 60000
const MAX_PATHS_PER_REQUEST = 6000
const STAT_CONCURRENCY = 16

const PROBE_ARGS = [
  '-v', 'error',
  '-show_entries',
  'stream=index,codec_type,codec_name,codec_tag_string,profile,level,pix_fmt,bits_per_raw_sample,channels,channel_layout,sample_rate,width,height,bit_rate,r_frame_rate,avg_frame_rate,color_range,color_space,color_transfer,color_primaries' +
    ':stream_side_data' + // Dolby Vision configuration record, mastering display, HDR10+
    ':stream_tags=language,title' +
    ':stream_disposition=default,attached_pic',
  '-show_entries', 'format=format_name,duration,bit_rate',
  '-of', 'json'
]

const num = (v) => {
  if (v == null || v === '' || v === 'N/A') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function frameRate(s) {
  for (const raw of [s.avg_frame_rate, s.r_frame_rate]) {
    const m = /^(\d+)\/(\d+)$/.exec(String(raw || ''))
    if (m && Number(m[2]) > 0) {
      const f = Number(m[1]) / Number(m[2])
      if (f > 0 && f < 1000) return Math.round(f * 1000) / 1000
    }
  }
  return null
}

// 'Dolby Vision' | 'HDR10+' | 'HDR10' | 'HLG' | 'SDR' (the one label the table column and the badges show).
function hdrOf(v, frameSideData) {
  const c = classify.classifyVideoStream(v, { frameSideData })
  return c ? c.hdrType : 'SDR'
}

function languagesOf(list) {
  const seen = []
  for (const s of list) {
    const name = tracks.languageName((s.tags && s.tags.language) || '') || 'Unknown'
    if (!seen.includes(name)) seen.push(name)
  }
  return seen
}

// Raw ffprobe JSON -> the compact record the table reads (and the cache stores). null when
// ffprobe found nothing that looks like media.
function parseProbe(parsed, sizeBytes, opts = {}) {
  if (!parsed || typeof parsed !== 'object') return null
  const streams = (Array.isArray(parsed.streams) ? parsed.streams : []).filter(Boolean)
  const format = parsed.format || {}
  const disp = (s) => s.disposition || {}
  const video = streams.find((s) => s.codec_type === 'video' && !disp(s).attached_pic)
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const subs = streams.filter((s) => s.codec_type === 'subtitle')
  if (!video && audio.length === 0) return null

  const durationSec = num(format.duration) || 0
  let totalKbps = num(format.bit_rate) ? Math.round(num(format.bit_rate) / 1000) : null
  if (!totalKbps && durationSec > 0 && sizeBytes > 0) totalKbps = Math.round((sizeBytes * 8) / durationSec / 1000)

  const cv = video ? classify.classifyVideoStream(video, { frameSideData: opts.frameSideData }) : null
  const ca = audio.map((s) => classify.classifyAudioStream(s))
  const whole = classify.classifyProbe(parsed, { frameSideData: opts.frameSideData })
  return {
    width: video ? num(video.width) : null,
    height: video ? num(video.height) : null,
    videoCodec: video ? video.codec_name || null : null,
    videoProfile: video ? video.profile || null : null,
    fps: video ? frameRate(video) : null,
    hdr: cv ? cv.hdrType : null,
    // Precise picture facts (mediaClassify.js): every HDR format present, the Dolby Vision profile ("8.1"), bit depth.
    hdrFormats: cv ? cv.hdrFormats : [],
    dvProfile: cv && cv.dolbyVision ? cv.dolbyVision.label : '',
    hdr10Plus: cv ? cv.hdr10Plus : false,
    bitDepth: cv ? cv.bitDepth : null,
    resolutionClass: cv ? cv.resolutionClass : null,
    // "4K", "Dolby Vision", "HDR10", "Atmos", "7.1": the short labels for the table, badges and details.
    badges: whole ? whole.badges : [],
    objectAudio: whole ? whole.objectAudio : [],
    videoKbps: video && num(video.bit_rate) ? Math.round(num(video.bit_rate) / 1000) : null,
    totalKbps,
    durationSec,
    formatName: format.format_name || null,
    audio: audio.map((s, i) => ({
      codec: s.codec_name || null,
      profile: s.profile || null,
      channels: num(s.channels),
      layout: s.channel_layout || null,
      isDefault: !!disp(s).default,
      family: ca[i].family,
      formatName: ca[i].name,
      objectAudio: ca[i].objectAudio,
      spatialFormat: ca[i].spatialFormat,
      lossless: ca[i].lossless
    })),
    audioLangs: languagesOf(audio),
    subLangs: languagesOf(subs),
    subCount: subs.length
  }
}

function defaultSetPriority(pid) {
  os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
}

async function mapLimit(items, limit, worker) {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
}

function keyFor(filePath, st) {
  return `${filePath}|${st.size}|${Math.floor(st.mtimeMs)}`
}

function pathOfKey(key) {
  const last = key.lastIndexOf('|')
  const prev = key.lastIndexOf('|', last - 1)
  return prev > 0 ? key.slice(0, prev) : key
}

function createLibraryInfo({
  ffprobePath,
  cacheFile,
  concurrency = 3,
  execFileFn = execFile,
  statFn = (p) => fs.promises.stat(p),
  setPriority = defaultSetPriority,
  flushMs = 250,
  saveMs = 3000,
  log = () => {}
} = {}) {
  const cache = new Map() // key -> probe record
  const byPath = new Map() // path -> key currently held for it
  const failed = new Set() // keys that failed to read, this run only
  const inFlight = new Set()
  const scopes = new Map() // scope -> { queue, active, buffer, timer, onBatch }
  let loaded = false
  let dirty = false
  let saveTimer = null
  let active = 0
  let rr = 0
  const exe = () => { try { return typeof ffprobePath === 'function' ? ffprobePath() : ffprobePath } catch { return null } }

  function load() {
    if (loaded) return
    loaded = true
    if (!cacheFile) return
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (raw && raw.v === CACHE_VERSION && raw.entries && typeof raw.entries === 'object') {
        for (const [key, probe] of Object.entries(raw.entries)) {
          cache.set(key, probe)
          byPath.set(pathOfKey(key), key)
        }
      }
    } catch { /* missing or damaged: start empty */ }
  }

  function serialize() {
    return JSON.stringify({ v: CACHE_VERSION, entries: Object.fromEntries(cache) })
  }
  async function writeCache() {
    if (!cacheFile || !dirty) return
    dirty = false
    try {
      await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true })
      const tmp = cacheFile + '.tmp'
      await fs.promises.writeFile(tmp, serialize())
      await fs.promises.rename(tmp, cacheFile)
    } catch (e) {
      dirty = true
      log('library info: could not save the cache: ' + e.message)
    }
  }
  // One write at a time, and a caller that asks while one is running waits for it.
  let saving = Promise.resolve()
  function saveNow() {
    saving = saving.then(writeCache)
    return saving
  }
  function saveSync() {
    if (!cacheFile || !dirty) return
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, serialize())
      dirty = false
    } catch { /* best effort on the way out */ }
  }
  function saveSoon() {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; saveNow() }, saveMs)
    if (saveTimer.unref) saveTimer.unref()
  }

  function forget(filePath) {
    const key = byPath.get(filePath)
    if (key === undefined) return
    cache.delete(key)
    byPath.delete(filePath)
    saveSoon()
  }

  function remember(filePath, key, probe) {
    const old = byPath.get(filePath)
    if (old !== undefined && old !== key) cache.delete(old)
    cache.set(key, probe)
    byPath.set(filePath, key)
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
      byPath.delete(pathOfKey(oldest))
    }
    saveSoon()
  }

  function probeFile(filePath, sizeBytes) {
    return new Promise((resolve) => {
      const bin = exe()
      if (!bin) return resolve(null)
      const inputArgs = require('./ffmpegArgs').inputArgs(filePath) // file: prefix + protocol whitelist (review F9)
      const child = execFileFn(
        bin,
        [...PROBE_ARGS, ...inputArgs],
        // windowsHide: no console window flashing up for every file read.
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null)
          let json
          let record
          try { json = JSON.parse(String(stdout)); record = parseProbe(json, sizeBytes) } catch { return resolve(null) }
          // HDR10+ lives in per-frame metadata: only a PQ HEVC / AV1 / VP9 picture is worth a second, tiny read.
          const vs = record && json && (json.streams || []).find((x) => x && x.codec_type === 'video' && !(x.disposition && x.disposition.attached_pic))
          if (!vs || !classify.wantsFrameProbe(vs)) return resolve(record)
          try {
            const c2 = execFileFn(bin, [...classify.FRAME_PROBE_ARGS, ...inputArgs], { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err2, out2) => {
              if (err2) return resolve(record)
              try {
                const seen = classify.parseFrameSideData(JSON.parse(String(out2)))
                resolve(seen.length ? parseProbe(json, sizeBytes, { frameSideData: seen }) : record)
              } catch { resolve(record) }
            })
            try { if (c2 && c2.pid) setPriority(c2.pid) } catch { /* optional */ }
          } catch { resolve(record) }
        }
      )
      try { if (child && child.pid) setPriority(child.pid) } catch { /* not every platform lets us */ }
    })
  }

  function scopeState(scope) {
    let sc = scopes.get(scope)
    if (!sc) {
      sc = { queue: [], active: 0, buffer: {}, timer: null, onBatch: null }
      scopes.set(scope, sc)
    }
    return sc
  }
  const remainingOf = (sc) => sc.queue.length + sc.active

  function flush(sc) {
    sc.timer = null
    const info = sc.buffer
    sc.buffer = {}
    if (Object.keys(info).length === 0) return
    try { if (sc.onBatch) sc.onBatch({ info, remaining: remainingOf(sc) }) } catch { /* the window may be gone */ }
  }
  function flushSoon(sc) {
    if (sc.timer) return
    sc.timer = setTimeout(() => flush(sc), flushMs)
    if (sc.timer.unref) sc.timer.unref()
  }

  async function run(sc, item) {
    inFlight.add(item.key)
    let probe = null
    try { probe = await probeFile(item.path, item.base.size) } catch { probe = null }
    inFlight.delete(item.key)
    let out
    if (probe) {
      remember(item.path, item.key, probe)
      out = { ...item.base, ...probe, probed: true }
    } else {
      failed.add(item.key)
      out = { ...item.base, probed: true, failed: true }
    }
    sc.buffer[item.path] = out
    flushSoon(sc)
  }

  // Round-robin over screens, so one screen's long queue cannot starve the other.
  function nextJob() {
    const list = [...scopes.values()]
    for (let n = 0; n < list.length; n++) {
      const sc = list[(rr + n) % list.length]
      while (sc.queue.length) {
        const item = sc.queue.shift()
        if (cache.has(item.key) || inFlight.has(item.key)) continue
        rr = (rr + n + 1) % list.length
        return { sc, item }
      }
    }
    return null
  }

  function pump() {
    while (active < concurrency) {
      const job = nextJob()
      if (!job) return
      active++
      job.sc.active++
      run(job.sc, job.item).finally(() => {
        active--
        job.sc.active--
        pump()
      })
    }
  }

  /**
   * Stat `paths` now and return what is known: { info: { [path]: record }, remaining, probeAvailable }.
   * A record always has size / mtimeMs / birthMs and `probed`; once probed it also has the
   * width, codecs, etc. (or `failed: true`). Files not yet read are queued (replacing this
   * scope's previous queue) and delivered later through `onBatch({ info, remaining })`.
   * A path that no longer exists comes back as { gone: true } and is dropped from the cache.
   * With `statOnly` nothing is queued and the scope's queue is left alone: for columns (Date
   * added) that only need the stat, so sorting by one never starts a probe of every file.
   */
  async function request(scope, paths, onBatch, { statOnly = false } = {}) {
    load()
    const list = [...new Set((Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p))].slice(0, MAX_PATHS_PER_REQUEST)
    const statted = new Array(list.length)
    await mapLimit(list, STAT_CONCURRENCY, async (p, i) => {
      try { statted[i] = await statFn(p) } catch { statted[i] = null }
    })
    const info = {}
    const queue = []
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      const st = statted[i]
      if (!st) {
        forget(p)
        info[p] = { gone: true }
        continue
      }
      const base = { size: st.size, mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs > 0 ? st.birthtimeMs : 0 }
      const key = keyFor(p, st)
      const hit = cache.get(key)
      if (hit) info[p] = { ...base, ...hit, probed: true }
      else if (failed.has(key)) info[p] = { ...base, probed: true, failed: true }
      else {
        info[p] = { ...base, probed: false }
        queue.push({ path: p, key, base })
      }
    }
    const sc = scopeState(scope)
    if (!statOnly) {
      sc.onBatch = onBatch
      sc.queue = queue
      pump()
    }
    return { info, remaining: remainingOf(sc), probeAvailable: !!exe() }
  }

  function cancel(scope) {
    const sc = scopes.get(scope)
    if (!sc) return
    sc.queue = []
    if (sc.timer) { clearTimeout(sc.timer); sc.timer = null }
    scopes.delete(scope)
  }

  return {
    request,
    cancel,
    saveNow,
    saveSync,
    status: () => ({ active, cached: cache.size, scopes: scopes.size, queued: [...scopes.values()].reduce((n, sc) => n + sc.queue.length, 0) })
  }
}

module.exports = { createLibraryInfo, parseProbe, hdrOf, PROBE_ARGS, CACHE_VERSION, keyFor, pathOfKey }
