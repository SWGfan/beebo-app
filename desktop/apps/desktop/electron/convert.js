const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')
const rules = require('./playbackRules')
const ffmpegArgs = require('./ffmpegArgs') // file: prefix + -protocol_whitelist for every library input
const backgroundGate = require('./backgroundGate')

// --- Automatic video conversion pipeline ---
// When a video fails to play in someone's browser (phone/tablet/etc), the
// player page flags it via /flag-unplayable and it lands in this queue. One
// ffmpeg job runs at a time; the original file is NEVER deleted or modified —
// the converted copy is written alongside it and the owner can compare the
// two in the Converted tab and delete whichever one they don't want (the old
// original to reclaim space, or the new copy if it looks worse).
//
// Loaded defensively (same pattern as busboy in streamServer.js): if someone
// launches the app before running `npm install` after these dependencies were
// added, the app must not crash — queued conversions just wait until the
// binaries exist on a later launch.
// FFmpeg/FFprobe resolution -- LGPL build ONLY (we deliberately do NOT bundle
// the GPL @ffmpeg-installer binary any more, so this app can be shipped as a
// paid product with only a short LGPL notice). Provide an LGPL FFmpeg build
// (one that includes the libopenh264 encoder) in resources/ffmpeg/ at packaging
// time -- see THIRD_PARTY_LICENSES/FFMPEG-SETUP.md -- or point BEEBO_FFMPEG /
// BEEBO_FFPROBE at one. If none is found the conversion feature just stays
// disabled, exactly as before -- nothing crashes.
function resolveFf(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name
  const candidates = [
    process.env['BEEBO_' + name.toUpperCase()],
    process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg', exe) : null,
    path.join(__dirname, '..', 'resources', 'ffmpeg', exe),
    path.join(__dirname, 'resources', 'ffmpeg', exe),
  ]
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch {}
  }
  return null
}
let FFMPEG_PATH = resolveFf('ffmpeg')
let FFPROBE_PATH = resolveFf('ffprobe')

const STORE_KEY = 'conversions'

let workerRunning = false
// Flipped by ensureWorker (called once at app startup from main.js) — enqueue
// only kicks the worker after that, so requiring this module in a plain node
// process (e.g. the unit tests) never spawns anything.
let workerStarted = false
// Re-kick timer so a paused/out-of-window converter starts itself again when conditions change.
let scheduleTimer = null
let log = (msg) => console.log('[convert]', msg)

function getAll(store) {
  return store.get(STORE_KEY) || []
}

function saveAll(store, list) {
  store.set(STORE_KEY, list)
}

function updateEntry(store, id, patch) {
  const list = getAll(store).map((e) => (e.id === id ? { ...e, ...patch } : e))
  saveAll(store, list)
  return list.find((e) => e.id === id)
}

// Output lands in the same folder as the original, same base name but .mp4 —
// unless that exact path already exists (including the original itself being
// an .mp4), in which case "<base> (converted).mp4" is used instead so nothing
// on disk is ever overwritten.
function outputPathFor(originalPath) {
  const dir = path.dirname(originalPath)
  const base = path.basename(originalPath, path.extname(originalPath))
  const candidate = path.join(dir, `${base}.mp4`)
  if (path.resolve(candidate) !== path.resolve(originalPath) && !fs.existsSync(candidate)) return candidate
  return path.join(dir, `${base} (converted).mp4`)
}

// Anything earlier than this is not a real wall-clock time. "Convert whole show" used to jump its
// episodes to the front by overwriting queuedAt with 1, 2, 3..., which every page then printed as
// 1 Jan 1970. Those entries are still in people's stores.
const SANE_TIME_MS = Date.UTC(2000, 0, 1)

// When an entry was really queued. A bogus queuedAt falls back to the id, which enqueue builds
// from Date.now() at the moment it was queued. null if neither is usable.
function queuedTimeOf(entry) {
  const q = entry && entry.queuedAt
  if (typeof q === 'number' && q >= SANE_TIME_MS) return q
  const m = /^(\d{12,})-/.exec(String((entry && entry.id) || ''))
  const t = m ? Number(m[1]) : 0
  return t >= SANE_TIME_MS ? t : null
}

// Front-of-queue position from "Convert whole show": [requestedAt, episode order], or null.
// A legacy entry whose queuedAt was overwritten with a tiny number keeps its place ahead of
// everything, in the order it was given.
function frontOfQueueKey(entry) {
  if (typeof entry.frontOfQueueAt === 'number') return [entry.frontOfQueueAt, Number(entry.frontOfQueueSeq) || 0]
  if (typeof entry.queuedAt === 'number' && entry.queuedAt < SANE_TIME_MS) return [0, entry.queuedAt]
  return null
}

// FIFO queue, except entries flagged from a device with NO cast button
// (castAvailable=false) jump ahead — those people have no workaround at all
// (can't even throw it to the TV), so their files convert first. Within that,
// episodes of a show someone asked to convert whole go before the rest of the
// library, one requested show after another.
function pickNext(list) {
  const queued = (list || []).filter((e) => e.status === 'queued')
  if (!queued.length) return null
  queued.sort((a, b) => {
    // A device that actually failed to play the file beats everything else.
    const aFail = a.deviceFailure ? 0 : 1
    const bFail = b.deviceFailure ? 0 : 1
    if (aFail !== bFail) return aFail - bFail
    const aCast = a.castAvailable ? 1 : 0
    const bCast = b.castAvailable ? 1 : 0
    if (aCast !== bCast) return aCast - bCast
    const aFront = frontOfQueueKey(a)
    const bFront = frontOfQueueKey(b)
    if (aFront && !bFront) return -1
    if (bFront && !aFront) return 1
    if (aFront && bFront) return (aFront[0] - bFront[0]) || (aFront[1] - bFront[1])
    return (a.queuedAt || 0) - (b.queuedAt || 0)
  })
  return queued[0]
}

// What a queue entry shows about WHY it is there (see playbackRules.decide).
function planOf(decision) {
  if (!decision || typeof decision !== 'object') return null
  return {
    action: decision.action,
    work: decision.work || '',
    reason: decision.reason || '',
    estimateSec: Number(decision.estimateSec) || 0,
    rulesVersion: decision.rulesVersion || rules.RULES_VERSION
  }
}

// Statuses that mean "not converting this, on purpose":
//   'not-needed'   - the rules say it plays as it is (or it already played fine on a device)
//   'dont-convert' - the owner pressed "Don't convert"; nothing automatic re-queues it
const PARKED = ['not-needed', 'dont-convert']

// opts:
//   deviceFailure - a phone/TV/browser reported it could not play this file
//   force         - the owner pressed "Convert anyway"
//   decision      - playbackRules.decide() result, stored so the tab can say why
function enqueue(store, { path: filePath, kind, castAvailable, deviceFailure, force, decision } = {}) {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid_path' }
  const resolved = path.resolve(filePath)
  const list = getAll(store)
  const parked = list.find((e) => path.resolve(e.originalPath) === resolved && PARKED.includes(e.status))
  if (parked) {
    // "Don't convert" wins over everything automatic, including device reports.
    if (parked.status === 'dont-convert' && !force) return { ok: false, id: parked.id, error: 'dont_convert', deduped: true }
    if (parked.status === 'not-needed' && !force && !deviceFailure) return { ok: true, id: parked.id, deduped: true, notNeeded: true }
    updateEntry(store, parked.id, {
      status: 'queued', queuedAt: Date.now(), error: null, progressPct: 0, startedAt: null, finishedAt: null,
      frontOfQueueAt: null, notNeededReason: null, force: !!force, deviceFailure: !!deviceFailure,
      castAvailable: castAvailable === false ? false : !!castAvailable,
      ...(decision ? { plan: planOf(decision) } : {})
    })
    kick(store)
    return { ok: true, id: parked.id, requeued: true }
  }
  // Dedupe: several family members hitting the same broken video shouldn't
  // queue it several times — and once it's converted ('done') there's nothing
  // left to do. 'rejected' counts too: the owner looked at that conversion,
  // decided it was worse than the original and deleted it, so the next flag
  // from the website must NOT silently redo the work they just threw away
  // (they can re-run it deliberately with "Convert again" in the Converted
  // tab). 'error'/'skipped' entries DO allow a re-add (a later flag is
  // effectively a retry request).
  const existing = list.find(
    (e) => path.resolve(e.originalPath) === resolved && ['queued', 'converting', 'done', 'rejected'].includes(e.status)
  )
  if (existing) {
    // A re-flag from a device with no cast button bumps a waiting entry's
    // priority — that person is fully stuck, not just inconvenienced.
    if (existing.status === 'queued' && castAvailable === false && existing.castAvailable !== false) {
      updateEntry(store, existing.id, { castAvailable: false })
    }
    if (existing.status === 'queued' && deviceFailure && !existing.deviceFailure) {
      updateEntry(store, existing.id, { deviceFailure: true })
    }
    return { ok: true, id: existing.id, deduped: true }
  }
  let originalBytes = 0
  try {
    originalBytes = fs.statSync(resolved).size
  } catch {
    originalBytes = 0
  }
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    originalPath: resolved,
    outputPath: outputPathFor(resolved),
    status: 'queued',
    kind: kind === 'tv' ? 'tv' : 'movie',
    castAvailable: !!castAvailable,
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    originalBytes,
    convertedBytes: null,
    error: null,
    progressPct: 0,
    originalDeleted: false,
    deviceFailure: !!deviceFailure,
    force: !!force,
    plan: planOf(decision)
  }
  list.push(entry)
  saveAll(store, list)
  log(`queued for conversion: ${resolved} (castAvailable=${!!castAvailable})`)
  kick(store)
  return { ok: true, id: entry.id }
}

// What every page shows: newest first, with queuedAt always a real time (or null), so an entry
// damaged by the old "Convert whole show" never prints as 1970. The stored entries are untouched,
// which is what keeps those episodes at the front of the queue.
function list(store) {
  return getAll(store)
    .map((e) => (e && e.queuedAt !== queuedTimeOf(e) ? { ...e, queuedAt: queuedTimeOf(e) } : e))
    .sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0))
}

// "Convert whole show": move these queued originals to the front, in the order given, behind any
// show that was asked for earlier. queuedAt is left alone - it is shown to people as a date.
function prioritize(store, originalPaths) {
  const order = new Map()
  for (const p of originalPaths || []) {
    const r = path.resolve(p)
    if (!order.has(r)) order.set(r, order.size)
  }
  if (!order.size) return 0
  const at = Date.now()
  let moved = 0
  const next = getAll(store).map((e) => {
    if (!e || e.status !== 'queued' || !e.originalPath) return e
    const seq = order.get(path.resolve(e.originalPath))
    if (seq === undefined) return e
    moved++
    return { ...e, frontOfQueueAt: at, frontOfQueueSeq: seq }
  })
  if (moved) saveAll(store, next)
  return moved
}

function retry(store, id) {
  const entry = getAll(store).find((e) => e.id === id)
  // 'rejected' is retryable too — that's the "Convert again" button on a
  // conversion the owner previously threw away (a deliberate re-run, unlike
  // the automatic re-queue that enqueue's dedupe blocks).
  if (entry && (entry.status === 'error' || entry.status === 'skipped' || entry.status === 'rejected')) {
    updateEntry(store, id, {
      status: 'queued',
      // "Convert again" on a file the rules had skipped as fine is the owner overruling them.
      ...(entry.status === 'skipped' && !entry.error ? { force: true } : {}),
      error: null,
      progressPct: 0,
      queuedAt: Date.now(),
      frontOfQueueAt: null,
      startedAt: null,
      finishedAt: null,
      convertedDeletedAt: null
    })
    kick(store)
  }
  return list(store)
}

// "Convert anyway": the owner overrules the rules (or their own "Don't convert"). The file is
// converted to the universal target (H.264 8-bit + AAC in MP4) even if it looks playable.
function convertAnyway(store, id) {
  const entry = getAll(store).find((e) => e.id === id)
  if (!entry || ['converting', 'done'].includes(entry.status)) return { ok: false, error: entry ? 'not_allowed' : 'not_found', conversions: list(store) }
  updateEntry(store, id, {
    status: 'queued', force: true, error: null, progressPct: 0, queuedAt: Date.now(), frontOfQueueAt: null,
    startedAt: null, finishedAt: null, convertedDeletedAt: null, notNeededReason: null
  })
  log(`convert anyway: ${entry.originalPath}`)
  kick(store)
  return { ok: true, conversions: list(store) }
}

// "Don't convert": park the entry. Nothing automatic (scan, whole show, device report) queues it
// again; "Convert anyway" is the only way back. Never touches a file.
function dontConvert(store, id) {
  const entry = getAll(store).find((e) => e.id === id)
  if (!entry || ['converting', 'done'].includes(entry.status)) return { ok: false, error: entry ? 'not_allowed' : 'not_found', conversions: list(store) }
  updateEntry(store, id, { status: 'dont-convert', force: false, progressPct: 0, dontConvertAt: Date.now() })
  log(`don't convert: ${entry.originalPath}`)
  return { ok: true, conversions: list(store) }
}

// The owner watched both files and decided the converted copy looks worse:
// delete the CONVERTED file (never the original) and mark the entry
// 'rejected'. A rejected entry sticks around on purpose — it's what stops the
// website auto-flagging the same original straight back into the queue (see
// enqueue's dedupe list).
function rejectConversion(store, id) {
  const entry = getAll(store).find((e) => e.id === id)
  if (!entry) return { ok: false, error: 'not_found', conversions: list(store) }
  if (!entry.outputPath) return { ok: false, error: 'no_output_path', conversions: list(store) }
  if (path.resolve(entry.outputPath) === path.resolve(entry.originalPath)) {
    return { ok: false, error: 'invalid_path', conversions: list(store) }
  }
  try {
    // force:true → an already-missing converted file (ENOENT) is not an error;
    // the entry still becomes 'rejected' so it stops being re-converted.
    fs.rmSync(entry.outputPath, { force: true })
  } catch (err) {
    return { ok: false, error: String(err), conversions: list(store) }
  }
  updateEntry(store, id, { status: 'rejected', convertedDeletedAt: Date.now(), progressPct: 0 })
  log(`converted copy rejected and deleted: ${entry.outputPath}`)
  return { ok: true, conversions: list(store) }
}

// Drops a row from the list without touching a single file on disk — used by
// "Remove from list" in the Converted tab. Forgetting a 'rejected' entry also
// clears the auto-re-conversion block on that original, which is the intended
// escape hatch.
function forgetEntry(store, id) {
  const remaining = getAll(store).filter((e) => e.id !== id)
  saveAll(store, remaining)
  return list(store)
}

// Probes the first video/audio stream codecs + container duration — the
// decision inputs for how light a conversion can be (see playbackRules.decide).
// opts.signal (optional AbortSignal) kills the ffprobe process; the probe then resolves null.
function probeStreams(filePath, opts) {
  const signal = opts && opts.signal
  return new Promise((resolve) => {
    if (!FFPROBE_PATH || (signal && signal.aborted)) {
      resolve(null)
      return
    }
    execFile(
      FFPROBE_PATH,
      [...rules.FFPROBE_ARGS, ...ffmpegArgs.inputArgs(filePath)],
      // windowsHide keeps Windows from flashing/parking a black console window
      // on screen for every probe — without it each ffprobe pops a cmd window.
      Object.assign({ timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, signal ? { signal } : {}),
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        try {
          // All streams, profiles, bit depth and the real container (playbackRules.normalizeProbe),
          // plus the flat videoCodec/audioCodec/... fields older callers read.
          resolve(rules.normalizeProbe(JSON.parse(stdout)))
        } catch {
          resolve(null)
        }
      }
    )
  })
}

// The conversion verdict: playbackRules.decide on the probed streams (never the extension alone).
function decideFor(probe, ext, opts) {
  return rules.decide(probe, ext, opts)
}

// Known-good evidence from watch history: a session that got past 5 minutes (or 20%) on some
// device. Returns { seconds, at } or null.
function knownGood(store, filePath) {
  try {
    const rows = store && typeof store.get === 'function' ? store.get('watchHistory') : null
    return rules.knownGoodFor(rules.playedSessionsIndex(rows), filePath)
  } catch {
    return null
  }
}

// Should an AUTOMATIC source (library scan, whole show, a "no cast button" report, the upgrade
// re-check) queue this file? Only when the rules say it needs work AND nobody has already played it.
function shouldAutoQueue(decision, knownGoodHit) {
  return rules.needsWork(decision) && !knownGoodHit
}

// LEGACY verdict, kept for callers and tests from before the stream-based rules.
// Will ORDINARY BROWSERS (a phone or laptop, in the app or the remote viewer) play this file as-is?
// This is a MUCH looser bar than Chromecast: browsers handle any H.264 level and non-faststart files
// just fine (HTTP Range covers a moov-at-the-end file). So we only flag a file for conversion when a
// browser genuinely can't play it: a non-MP4/WebM container (MKV, AVI), a video codec browsers don't
// decode (HEVC/H.265, MPEG-2, VC-1), or an audio codec they can't (AC3, E-AC3, DTS, TrueHD).
function isBrowserPlayable(probe, ext) {
  const e = String(ext || '').toLowerCase()
  if (e !== '.mp4' && e !== '.m4v' && e !== '.webm' && e !== '.mov') return false
  if (!probe) return false
  const v = probe.videoCodec
  if (v !== 'h264' && v !== 'vp8' && v !== 'vp9' && v !== 'av1') return false
  if (!probe.hasAudio) return true
  const a = probe.audioCodec
  return a === 'aac' || a === 'mp3' || a === 'opus' || a === 'vorbis'
}

// What runOne does with one entry, decided from its probe:
//   { skip, parkAs, decision }        - leave the file alone
//   { mode, args, decision }          - run ffmpeg with these codec/map args
// A device failure or "Convert anyway" uses the strict (every-Chromecast) target; everything
// else uses the normal rules, and a file that already played fine on a device is not touched.
function planJob(store, entry, probe) {
  const src = entry.originalPath
  const ext = path.extname(src).toLowerCase()
  const strict = !!(entry.force || entry.deviceFailure)
  const decision = rules.decide(probe, ext, { strict })
  if (!strict) {
    if (decision.action === 'unknown') return { skip: decision.reason, decision }
    if (!rules.needsWork(decision)) return { skip: 'plays as it is', parkAs: 'not-needed', decision }
    const good = knownGood(store, src)
    if (good) return { skip: `already played fine for ${Math.round(good.seconds / 60)} min on a device`, parkAs: 'not-needed', decision }
  }
  // Convert anyway on a file that is already in the universal format: a plain remux (faststart MP4).
  const effective = decision.action === 'unknown' ? { action: 'video', strict } : decision.action === 'none' ? { ...decision, action: 'remux' } : decision
  const { mode, args } = rules.planArgs(effective, probe)
  return { mode, args, decision }
}

// Is the MP4 index (moov) already at the FRONT of the file ("faststart")? Walks the top-level
// atoms cheaply (reads only 16-byte box headers, seeking by box size) and returns true if moov is
// seen before mdat. A file whose moov sits after mdat starts instantly nowhere: Chromecast sits on
// the cast logo waiting to download the whole file to find the index, and streaming players stall
// or fail. Such a file must NOT be treated as "already fine" even when it's h264/aac. Any read
// error is treated as "not faststart" so we err toward fixing it.
function isFaststart(filePath) {
  let fd = null
  try {
    fd = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(fd).size
    let pos = 0
    const hdr = Buffer.alloc(16)
    while (pos + 8 <= size) {
      const n = fs.readSync(fd, hdr, 0, 16, pos)
      if (n < 8) break
      let boxSize = hdr.readUInt32BE(0)
      const type = hdr.toString('latin1', 4, 8)
      let headerLen = 8
      if (boxSize === 1) {
        // 64-bit largesize in the next 8 bytes.
        if (n < 16) break
        const hi = hdr.readUInt32BE(8)
        const lo = hdr.readUInt32BE(12)
        boxSize = hi * 4294967296 + lo
        headerLen = 16
      } else if (boxSize === 0) {
        // Box extends to end of file — it's the last one.
        boxSize = size - pos
      }
      if (type === 'moov') return true
      if (type === 'mdat') return false
      if (boxSize < headerLen) break
      pos += boxSize
    }
    return false
  } catch {
    return false
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
}

// Runs one conversion start-to-finish, updating the store entry as it goes.
function runOne(store, entry) {
  return new Promise((resolve) => {
    const src = entry.originalPath
    if (!fs.existsSync(src)) {
      updateEntry(store, entry.id, { status: 'error', error: 'Original file no longer exists', finishedAt: Date.now() })
      resolve()
      return
    }

    probeStreams(src).then((probe) => {
      const job = planJob(store, entry, probe)
      if (job.skip) {
        log(`skipping (${job.skip}): ${src}`)
        updateEntry(store, entry.id, { status: job.parkAs || 'skipped', finishedAt: Date.now(), error: null, notNeededReason: job.skip, plan: planOf(job.decision) || entry.plan || null })
        resolve()
        return
      }

      // Recomputed at start time (not just at enqueue) in case files moved
      // around since this entry was queued.
      const outputPath = outputPathFor(src)
      const tempPath = outputPath.replace(/\.mp4$/i, '.converting.mp4')
      const { args: codecArgs, mode } = job
      const durationSec = probe?.durationSec || 0

      updateEntry(store, entry.id, { status: 'converting', startedAt: Date.now(), outputPath, progressPct: 0, error: null })
      log(`converting (${mode}): ${src} -> ${outputPath}`)

      // -map 0:v:0 / 0:a:0? — only the first video and (if present) first
      // audio stream, so exotic extra streams can't fail the job; -sn/-dn
      // drop subtitle/data streams; -movflags +faststart moves the MP4 index
      // to the front of the file, which is critical for instant start and
      // seeking over HTTP.
      // The plan carries its own -map list (first video, the audio it keeps, text subtitles as
      // mov_text); image subtitles and data streams are left out because MP4 cannot hold them.
      const hasSubs = codecArgs.includes('-c:s')
      const args = [
        '-hide_banner',
        '-nostdin',
        '-y',
        ...ffmpegArgs.inputArgs(src), // file: prefix + protocol whitelist (review F9)
        ...(hasSubs ? [] : ['-sn']),
        '-dn',
        ...codecArgs,
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        tempPath
      ]

      let child
      try {
        // windowsHide: true is essential on Windows — a conversion runs for many
        // minutes, and without it ffmpeg parks a visible black console window on
        // the user's desktop for the whole job (and clicking in it SUSPENDS the
        // conversion, because of the console's QuickEdit selection mode).
        child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        // Keep the machine responsive: run the transcode at BELOW-normal priority so a long
        // ffmpeg job can't starve the desktop/server of CPU (added after a full-system freeze that
        // coincided with a conversion). Best-effort; ignored if the platform refuses.
        try {
          const os = require('os')
          os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
        } catch (_) {}
      } catch (err) {
        updateEntry(store, entry.id, { status: 'error', error: String(err), finishedAt: Date.now() })
        resolve()
        return
      }

      // ffmpeg's -progress output is key=value lines; out_time_us/out_time_ms
      // are microseconds of output produced so far. Store writes are
      // throttled (>=1% change AND >=2s apart) so a long transcode doesn't
      // hammer the settings file.
      let lastPct = -1
      let lastWrite = 0
      let stdoutBuf = ''
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString()
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop()
        for (const line of lines) {
          const m = line.match(/^out_time_(?:us|ms)=(\d+)/)
          if (!m || !durationSec) continue
          const pct = Math.max(0, Math.min(99, Math.round(((parseInt(m[1], 10) / 1e6) / durationSec) * 100)))
          const now = Date.now()
          if (pct > lastPct && now - lastWrite >= 2000) {
            lastPct = pct
            lastWrite = now
            updateEntry(store, entry.id, { progressPct: pct })
          }
        }
      })

      // Keep the tail of stderr for a useful error message on failure.
      let stderrTail = ''
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000)
      })

      const cleanupTemp = () => {
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
        } catch {
          // best effort — a leftover *.converting.mp4 is hidden from scans anyway
        }
      }

      child.on('error', (err) => {
        cleanupTemp()
        updateEntry(store, entry.id, { status: 'error', error: String(err), finishedAt: Date.now() })
        resolve()
      })

      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(tempPath)) {
          try {
            fs.renameSync(tempPath, outputPath)
            // The converted copy is the same film or episode, not a new arrival: give it the
            // original's file times so it does not jump to the top of Recently Added. Best-effort.
            try {
              const srcStat = fs.statSync(src)
              fs.utimesSync(outputPath, srcStat.atime, srcStat.mtime)
            } catch (_) {}
            const convertedBytes = fs.statSync(outputPath).size
            updateEntry(store, entry.id, {
              status: 'done',
              outputPath,
              convertedBytes,
              progressPct: 100,
              finishedAt: Date.now(),
              error: null
            })
            log(`done: ${outputPath} (${convertedBytes} bytes)`)
            // Optional "delete as you go": when the owner has turned it on, remove the original
            // the instant its converted copy lands, so a big batch never needs double the disk.
            // Guarded like the manual accept: a sane-sized converted file at a different path.
            try {
              if (store.get('autoDeleteOriginals') &&
                  convertedBytes > 1024 * 1024 &&
                  path.resolve(outputPath) !== path.resolve(src) &&
                  fs.existsSync(src)) {
                fs.rmSync(src, { force: true })
                updateEntry(store, entry.id, { originalDeleted: true })
                log(`auto-deleted original: ${src}`)
              }
            } catch (e) { log(`auto-delete failed for ${src}: ${e}`) }
          } catch (err) {
            cleanupTemp()
            updateEntry(store, entry.id, { status: 'error', error: String(err), finishedAt: Date.now() })
          }
        } else {
          cleanupTemp()
          const lastLine = stderrTail.trim().split('\n').pop() || ''
          updateEntry(store, entry.id, {
            status: 'error',
            error: `ffmpeg exited with code ${code}${lastLine ? ` — ${lastLine}` : ''}`,
            finishedAt: Date.now()
          })
          log(`failed (code ${code}): ${src}`)
        }
        resolve()
      })
    })
  })
}

// Whether the converter may START a new job right now: not manually paused, and — if an overnight
// window is set — inside it. A job already running is never interrupted; this only gates the NEXT.
function conversionsAllowedNow(store) {
  try {
    if (store.get('conversionsPaused')) return false
    const ws = store.get('conversionWindowStart')
    const we = store.get('conversionWindowEnd')
    if (typeof ws === 'number' && typeof we === 'number' && ws !== we) {
      const h = new Date().getHours()
      const inWindow = ws < we ? (h >= ws && h < we) : (h >= ws || h < we)
      if (!inWindow) return false
    }
  } catch (_) {}
  return true
}

// Keep at least this much free on the output drive; a big transcode must never fill the disk.
const MIN_FREE_DEFAULT = 5 * 1024 * 1024 * 1024 // 5 GB
function minFreeBytes(store) {
  try { const v = store.get('minFreeConversionBytes'); if (typeof v === 'number' && v >= 0) return v } catch (_) {}
  return MIN_FREE_DEFAULT
}
function freeBytesFor(dir) {
  try { const st = fs.statfsSync(dir); return st.bavail * st.bsize } catch (_) { return -1 }
}

// Starts the worker loop if it isn't already running — guarded so two
// overlapping kicks (e.g. two flags arriving at once) can never run two
// ffmpeg jobs in parallel.
function kick(store) {
  if (!workerStarted || workerRunning || reevaluating) return
  workerRunning = true
  ;(async () => {
    try {
      if (!FFMPEG_PATH || !FFPROBE_PATH) {
        log('ffmpeg/ffprobe not installed yet (run npm install in apps/desktop) — queued conversions will wait')
        return
      }
      for (;;) {
        if (!conversionsAllowedNow(store)) break
        const next = pickNext(getAll(store))
        if (!next) break
        // Routine conversions wait while the PC is on battery or busy (backgroundGate.js); someone whose
        // device already failed to play a file, or who was put at the front of the queue by hand, does not.
        // The 5-minute timer kicks again, so nothing is dropped.
        if (!next.deviceFailure && !next.frontOfQueueAt) {
          let held = null
          try { const g = backgroundGate.check({ ignore: ['playback'] }); if (g.defer) held = g.reason } catch (_) {}
          if (held) { log('conversion held back while the PC is ' + (held === 'battery' ? 'on battery power' : 'busy') + ' (retries every 5 minutes)'); break }
        }
        // Disk guardrail: never start a job when the output drive is nearly full — it could fill
        // the disk and make the whole PC unstable. Auto-resumes on a later kick once space frees.
        try {
          const outDir = path.dirname(next.outputPath || '')
          const free = outDir ? freeBytesFor(outDir) : -1
          if (free >= 0 && free < minFreeBytes(store)) {
            if (!store.get('conversionsLowDisk')) store.set('conversionsLowDisk', true)
            log('paused: low disk (' + (Math.round(free / 1e8) / 10) + ' GB free) — will retry when space frees')
            break
          }
          if (store.get('conversionsLowDisk')) store.set('conversionsLowDisk', false)
        } catch (_) {}
        try {
          await runOne(store, next)
        } catch (err) {
          updateEntry(store, next.id, { status: 'error', error: String(err), finishedAt: Date.now() })
        }
      }
    } finally {
      workerRunning = false
    }
  })()
}

// --- one-time re-check of the queue when the rules change ---------------------------------
// Earlier releases queued every .mkv and .avi by extension. On the first start with newer rules,
// every WAITING entry the owner or a device did not ask for explicitly is probed again:
//   * plays as it is, or already played fine on a device -> 'not-needed' (kept in the list with
//     its reason, so "Convert anyway" is one click; no file is touched)
//   * still needs work -> stays queued, now with its plain-English reason and time estimate
// Entries that are converting, done, rejected, failed or skipped are never touched.
// The summary lands in store 'conversionRulesSummary' for the Conversions tab to show once.
const RULES_VERSION_KEY = 'conversionRulesVersion'
const RULES_SUMMARY_KEY = 'conversionRulesSummary'
let reevaluating = false

async function reevaluateQueue(store, { probe = probeStreams, concurrency = 4, force = false } = {}) {
  if (!force && Number(store.get(RULES_VERSION_KEY)) >= rules.RULES_VERSION) return { ran: false }
  if (reevaluating) return { ran: false, busy: true }
  reevaluating = true
  try {
    const targets = getAll(store).filter((e) => e && e.status === 'queued' && !e.force && !e.deviceFailure)
    const history = rules.playedSessionsIndex(store.get('watchHistory'))
    const verdicts = new Map()
    let next = 0
    const lane = async () => {
      while (next < targets.length) {
        const e = targets[next++]
        let exists = false
        try { exists = fs.existsSync(e.originalPath) } catch { exists = false }
        if (!exists) continue // runOne reports a missing file as an error; nothing to decide here
        let pr = null
        try { pr = await probe(e.originalPath) } catch { pr = null }
        const decision = rules.decide(pr, path.extname(e.originalPath).toLowerCase())
        const good = rules.knownGoodFor(history, e.originalPath)
        verdicts.set(e.id, { decision, good })
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane))
    let removed = 0, kept = 0, playedFine = 0
    const byAction = { remux: 0, audio: 0, video: 0 }
    // Apply against the CURRENT list, so nothing written while probing is lost.
    const now = Date.now()
    const updated = getAll(store).map((e) => {
      const v = e && e.status === 'queued' && verdicts.get(e.id)
      if (!v) return e
      if (v.decision.action === 'unknown') { kept++; return { ...e, plan: planOf(v.decision) } }
      if (!rules.needsWork(v.decision) || v.good) {
        removed++
        if (v.good && rules.needsWork(v.decision)) playedFine++
        const why = v.good && rules.needsWork(v.decision)
          ? `Already played fine for ${Math.round(v.good.seconds / 60)} min on a device`
          : v.decision.reason
        return { ...e, status: 'not-needed', notNeededReason: why, removedByRulesAt: now, plan: planOf(v.decision) }
      }
      kept++
      byAction[v.decision.action] = (byAction[v.decision.action] || 0) + 1
      return { ...e, plan: planOf(v.decision) }
    })
    saveAll(store, updated)
    const summary = { version: rules.RULES_VERSION, at: now, checked: verdicts.size, removed, playedFine, kept, byAction, dismissed: false }
    if (removed || kept) store.set(RULES_SUMMARY_KEY, summary)
    store.set(RULES_VERSION_KEY, rules.RULES_VERSION)
    log(`queue re-checked with rules v${rules.RULES_VERSION}: ${removed} removed (play fine as they are), ${kept} still need work`)
    return { ran: true, ...summary }
  } finally {
    reevaluating = false
  }
}

function dismissRulesSummary(store) {
  const s = store.get(RULES_SUMMARY_KEY)
  if (s && typeof s === 'object') store.set(RULES_SUMMARY_KEY, { ...s, dismissed: true })
}

// Called once at app startup (main.js) — recovers entries left mid-conversion
// by a crash/quit back to 'queued', then resumes the queue.
function ensureWorker(store, logFn) {
  if (typeof logFn === 'function') log = logFn
  workerStarted = true
  const all = getAll(store)
  let changed = false
  const recovered = all.map((e) => {
    if (e.status !== 'converting') return e
    changed = true
    // A job still marked 'converting' at startup means the app was killed mid-transcode (a crash,
    // power loss, or a hard shutdown). Rather than blindly re-running the very file that was active
    // when things went wrong, mark it 'skipped' so it does NOT auto-resume; the owner can retry it
    // by hand from the Converted tab if they still want it.
    return {
      ...e,
      status: 'skipped',
      progressPct: 0,
      startedAt: null,
      error: 'Skipped after an unexpected shutdown \u2014 retry manually if you still want this one.',
    }
  })
  if (changed) saveAll(store, recovered)
  if (!scheduleTimer) {
    scheduleTimer = setInterval(() => { try { kick(store) } catch (_) {} }, 5 * 60 * 1000)
    if (scheduleTimer && scheduleTimer.unref) scheduleTimer.unref()
  }
  // Re-check the waiting queue against the current rules first (once per rules version), so a
  // file that plays fine is never started just because it was queued by an older release.
  if (!(Number(store.get(RULES_VERSION_KEY)) >= rules.RULES_VERSION)) {
    reevaluateQueue(store)
      .catch((err) => log(`queue re-check failed: ${err}`))
      .finally(() => kick(store))
    return
  }
  kick(store)
}

module.exports = {
  // The resolved ffmpeg / ffprobe paths (null when not installed), for live playback conversion.
  ffmpegPath: () => FFMPEG_PATH,
  ffprobePath: () => FFPROBE_PATH,
  enqueue,
  kick,
  isFaststart,
  probeStreams,
  isBrowserPlayable,
  list,
  prioritize,
  retry,
  rejectConversion,
  forgetEntry,
  ensureWorker,
  convertAnyway,
  dontConvert,
  decideFor,
  knownGood,
  shouldAutoQueue,
  reevaluateQueue,
  dismissRulesSummary,
  RULES_SUMMARY_KEY,
  // exported for unit tests
  outputPathFor,
  pickNext,
  planJob,
  runOne,
  queuedTimeOf
}
