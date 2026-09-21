'use strict'
// ============================================================================
// playbackApi.js - the HTTP side of "Quality & audio" (phone, TV, web viewer).
// ----------------------------------------------------------------------------
// Kept out of streamServer.js on purpose: streamServer only forwards to it.
//
//  Signed-in routes (phone app under /api, web viewer under /playback-api):
//   GET  /playback/info?kind=&id=        what is in the file + qualities + prefs
//   POST /playback/start                 {kind,id,quality,audio,burnSubtitle, and optionally
//                                         audioMode: auto|stereo|surround|passthrough, downmix: standard|dialogue,
//                                         night, normalize, audioDelayMs, audioCaps:{maxChannels,codecs}} -> HLS url
//                                        (no audio fields = stereo AAC exactly as before; see hlsAudio.js)
//   POST /playback/stop                  {ticket} - the viewer left / switched
//   GET  /playback/prefs  POST /playback/prefs    remembered choices, per user (+profile), incl.
//                                        subtitleStyle {size,color,bg,bgOpacity,edge,position,font} (subtitleStyle.js)
//   GET  /playback/info also carries `chapters` [{index,startSec,endSec,title}] (chapterModel.js)
//   POST /playback/version             {id, versionId} remember which file of a film this user opens
//                                        (info() lists a film's `versions` + `preferredVersionId`); '' forgets
//   GET  /playback/speedtest?kb=         random bytes, for Auto to time over the real path
//   GET  /playback/status                encoder + running conversions
//   POST /playback/negotiate             {kind,id, deviceProfile?, client?, audio?, quality?, subtitle?, maxBitrateKbps?} -> the plan
//                                        (DirectPlay | DirectStream | Transcode, per-stream actions, machine-readable reasons) and the
//                                        URL that plays it (homeTheater.js / playbackDecision.js / hlsRemux.js). /playback/info carries
//                                        the same plan for the calling device as `homeTheater`, plus badges (4K, HDR10+, Atmos, 7.1).
//   GET  /playback/hometheater           the calling device's profile + the effective Home theater settings for this person
//   GET  /playback/trickplay/info?kind=&id=        seek-bar preview availability + thumb url
//   GET  /subtitles/online?kind=&id=&lang=         OpenSubtitles search (owner's key)
//   POST /subtitles/online/download      {kind,id,fileId,lang,hearingImpaired,forced}
//
//  Ticket / media-token routes (no login; what players, Cast and the tunnel fetch):
//   GET  /hls/<ticket>/index.m3u8        whole-film VOD playlist
//   GET  /hls/<ticket>/seg-<n>.ts        one piece (starts/moves the conversion)
//   GET  /subtitles/embedded?kind=&id=&s=<stream>&mt=   an embedded text track as WebVTT
//   GET  /trickplay/thumb?kind=&id=&t=<sec>&mt=         one seek-bar preview JPEG
//
// Seek-bar previews ("trickplay", GET /playback/trickplay/info + /trickplay/thumb) are a small
// addition living in this file rather than a module of their own: they reuse the same file
// resolution, media tokens and track prober as everything else here. See trickplayRules.js for
// the (unit-tested, ffmpeg-free) math and the "trickplay" section below for the ffmpeg pass,
// disk cache and routes.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn: spawnImpl } = require('child_process')

const hls = require('./hlsTranscoder')
const encoderCaps = require('./encoderCapabilities')
const hlsAudio = require('./hlsAudio')
const audioPrefs = hlsAudio.audioPrefs
const tracksLib = require('./playbackTracks')
const openSubs = require('./openSubtitles')
const rules = require('./playbackRules')
const titleParse = require('./titleParse')
const trickplay = require('./trickplayRules')
const subtitleStyle = require('./subtitleStyle')
const trickplayCache = require('./trickplayCache')
const trickplayJob = require('./trickplayJob')
const movieVersions = require('./movieVersions')
const homeTheaterModule = require('./homeTheater') // device profiles, direct play / direct stream / transcode decision, HDR-preserving remux
// Household plan -> away-from-home quality cap (pure; same module streamServer.js's own
// enforcement uses). This module only ever ADVISES the client so it can explain/self-limit
// itself - the real enforcement for direct/"Original" file requests lives in streamServer.js's
// enforceAwayQualityCap, independent of anything below.
const awayQualityPolicy = require('./awayQualityPolicy')

const QUALITY_PREFS = new Set(['auto', 'original', '1080p', '720p', '480p'])
// One MPEG-TS null packet (PID 0x1FFF): valid transport stream that every demuxer skips.
const TS_NULL_PACKET = (() => { const b = Buffer.alloc(188, 0xff); b[0] = 0x47; b[1] = 0x1f; b[2] = 0xff; b[3] = 0x10; return b })()

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { resolve(null); try { req.destroy() } catch {} ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

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

/** Can the original file play as it is on the phone app / a Chromecast / an ordinary browser? */
function directVerdicts(tracks, ext) {
  const probe = tracks && tracks.raw ? rules.normalizeProbe(tracks.raw) : null
  if (!probe) return { android: true, cast: true, browser: false, reason: '' }
  const normal = rules.decide(probe, ext, {})
  const strict = rules.decide(probe, ext, { strict: true })
  return {
    android: !rules.needsWork(normal),
    cast: !rules.needsWork(strict) || !rules.needsWork(normal),
    castSafe: !rules.needsWork(strict),
    browser: isBrowserPlayable(probe, ext),
    reason: rules.needsWork(normal) ? (normal.reason || '') : ''
  }
}

function originalLabel(tracks) {
  const parts = ['Original']
  const h = tracks && tracks.video && tracks.video.height
  if (h) parts.push(h >= 2000 ? '4K' : `${h >= 1070 ? 1080 : h >= 700 ? 720 : h >= 560 ? 576 : h >= 470 ? 480 : h}p`)
  const kbps = tracks && (tracks.bitrateKbps || (tracks.video && tracks.video.bitrateKbps))
  if (kbps) parts.push(`${(kbps / 1000).toFixed(kbps >= 10000 ? 0 : 1)} Mbps`)
  return parts.join(' · ')
}

function searchTermsFor(kind, id, decodeId, filePath) {
  let rel = ''
  try { rel = decodeId(id) || '' } catch { rel = '' }
  const base = path.basename(filePath || rel)
  if (kind === 'tv') {
    const ep = titleParse.parseEpisode(base)
    let show = ep.show
    const top = String(rel).split(/[\\/]/).filter(Boolean)
    if ((!ep.season || !show || show === base) && top.length > 1) show = titleParse.cleanText(top[0]) || show
    return { query: show, year: ep.year || null, season: ep.season, episode: ep.episode, type: 'episode' }
  }
  const m = titleParse.parseMovieTitle(base)
  return { query: m.title || titleParse.cleanTitle(base), year: m.year || null, type: 'movie' }
}

function createPlaybackApi({
  store,
  log = () => {},
  resolveFile,          // async (kind, id) => absolute path | null
  listSidecars,         // (kind, id) => [{ lang, label }]  (same order as /subtitles/file?i=)
  sign,                 // (id) => media token
  verify,               // (id, token) => boolean
  decodeId = (x) => x,
  ffmpegPath,           // () => path | null
  ffprobePath,          // () => path | null
  tmpRoot = path.join(os.tmpdir(), 'beebo-playback'),
  mediaTokenHeader = 'x-beebo-media-token',
  fetchImpl = globalThis.fetch,
  openSubtitlesBase,
  // Tests (and only tests) replace the whole encoder check with this: (opts) => { encoder, label, ... }.
  runEncoderProbe = null,
  // The cached, proven encoder capabilities (encoderCapabilities.createEncoderService). One per app;
  // Settings > Hardware acceleration reads the same instance through streamServer's `transcode` handle.
  encoderService = null,
  encoderRun = null,
  spawnFn,
  managerOptions = {},
  keepAliveMs = 5000,
  // Optional: electron/license.js's instance. With it, /playback/info tells the client the
  // household's away-from-home quality cap height (see awayQualityCapHeight below) so it can
  // explain/self-limit "Original" instead of silently getting a worse picture with no reason.
  // Without it (older callers, most tests), the field is always null - advisory only; nothing
  // here enforces anything, see streamServer.js's enforceAwayQualityCap for that.
  license,
  // Optional: (kind, id, durationSec) => the effective intro/credits markers (viewer-set first, then
  // auto-detected). Without it /playback/info simply has no `markers` field, exactly as before.
  markersFor,
  // Tests only: queue timing for the seek-preview passes (pollMs, sleep, pauseBetweenMs).
  trickplayOptions = {},
  // Optional: async (kind, id) => { groupKey, versions: [{ id, label, height, hdr, edition, sizeBytes, isDefault }] } | null,
  // the other files of the same film (streamServer.js's library index). Without it /playback/info has no `versions`.
  versionsFor
}) {
  const getFfmpeg = () => { try { return typeof ffmpegPath === 'function' ? ffmpegPath() : ffmpegPath } catch { return null } }
  const getFfprobe = () => { try { return typeof ffprobePath === 'function' ? ffprobePath() : ffprobePath } catch { return null } }
  const setting = (k, d) => { try { const v = store.get(k); return v === undefined || v === null || v === '' ? d : v } catch { return d } }
  // Mirrors streamServer.js's currentAwayQualityCap: the verified license payload is the
  // authoritative plan source, store('license.plan') is only a same-process fallback. Returns a
  // height in pixels (today only ever 1080 or null - see awayQualityPolicy.js) rather than the
  // '1080p'/'4k' string, since that's what the client compares a real height against.
  function awayQualityCapHeight() {
    try {
      if (!license || typeof license.evaluate !== 'function') return null
      const ev = license.evaluate()
      if (!ev || !ev.enforced) return null
      let plan = ev.payload && ev.payload.plan
      if (!plan) { try { plan = store.get('license.plan') } catch { plan = null } }
      const cap = awayQualityPolicy.awayQualityCapForPlan(plan || 'beebo-standard')
      return cap === '4k' ? null : 1080
    } catch {
      return null
    }
  }

  const prober = tracksLib.createTrackProber({ ffprobePath: getFfprobe })
  const extractor = tracksLib.createSubtitleExtractor({ ffmpegPath: getFfmpeg, cacheDir: path.join(tmpRoot, 'subtitles'), ...(spawnFn ? { spawnFn } : {}) })
  const encoders = encoderService || encoderCaps.createEncoderService({
    getFfmpegPath: getFfmpeg, store, log, run: encoderRun, getCpuMode: () => setting('transcodeCpuMode', '')
  })
  const manager = hls.createTranscodeManager({
    ffmpegPath: getFfmpeg,
    tmpRoot: path.join(tmpRoot, 'hls'),
    // Chosen by the owner, else gentle on a weak PC / a little more with a graphics encoder.
    maxConcurrent: () => Math.min(8, Math.max(1, Number(setting('transcodeMaxConcurrent', 0)) || encoders.defaultMax(setting('transcodeEncoder', '')) || 2)),
    log,
    profile: () => encoders.profile(),
    onEncoderFailure: (id, why) => encoders.noteFailure(id, why),
    onEncoderSuccess: (id) => encoders.noteSuccess(id),
    ...(spawnFn ? { spawnFn } : {}),
    ...managerOptions
  })
  const subtitleClient = openSubs.createOpenSubtitlesClient({
    config: () => ({ apiKey: setting('openSubtitlesApiKey', ''), username: setting('openSubtitlesUsername', ''), password: setting('openSubtitlesPassword', '') }),
    fetchImpl,
    ...(openSubtitlesBase ? { baseUrl: openSubtitlesBase } : {})
  })

  // ------------------------------------------------------------- trickplay
  // Seek-bar preview thumbnails: generate once (a single ffmpeg pass per file that decodes only key
  // frames), cache to disk under an owner-set size limit with least-recently-used eviction, serve
  // statically. Purely a local/home-network serving concern - nothing here touches Beebo Relay
  // bandwidth or quality-tier policy (awayQualityPolicy.js is a separate, unrelated file).
  // WHEN a pass runs is trickplayJob.js's business: a viewer's own request runs at once (it is the
  // stream in progress), the library-wide background sweep waits until the house is quiet.
  const trickplayCacheRoot = path.join(tmpRoot, 'trickplay')
  const trickplayEnabled = () => setting('trickplayEnabled', true) !== false
  const trickplayMaxBytes = () => trickplayCache.clampMaxMB(setting('trickplayCacheMaxMB', trickplayCache.DEFAULT_MAX_MB)) * trickplayCache.MB
  // Set by startTrickplaySweep once the server can say who is watching; until then nobody is.
  let houseBusy = () => false
  // "<key>.part" directories a running pass owns, so the stale-part sweep never deletes one.
  const partsInFlight = new Set()
  const trickplayQueue = trickplayJob.createTrickplayQueue({ isBusy: () => houseBusy(), enabled: trickplayEnabled, log, ...trickplayOptions })
  let trickplaySweep = null

  function trickplayDirFor(filePath, sizeBytes, mtimeMs, intervalSec, width) {
    return path.join(trickplayCacheRoot, trickplay.cacheKeyFor(filePath, sizeBytes, mtimeMs, intervalSec, width))
  }

  function readTrickplayManifest(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch { return null }
  }

  function pruneTrickplayCache(protectName) {
    try {
      trickplayCache.prune(trickplayCacheRoot, { maxBytes: trickplayMaxBytes(), protect: new Set(protectName ? [protectName] : []) })
      trickplayCache.sweepStaleParts(trickplayCacheRoot, { inFlight: partsInFlight })
    } catch {}
  }

  function runTrickplayFfmpeg(exe, args) {
    return new Promise((resolve) => {
      let child
      try {
        child = (spawnFn || spawnImpl)(exe, args, { stdio: 'ignore', windowsHide: true })
      } catch {
        resolve(false)
        return
      }
      // Below-normal priority: a preview pass must never compete with a film being converted.
      try { if (child && child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
      // A stuck/runaway ffmpeg (a pathological file) must not sit there forever.
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 10 * 60 * 1000)
      if (timer.unref) timer.unref()
      let done = false
      const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); resolve(ok) }
      child.on('error', () => finish(false))
      child.on('close', (code) => finish(code === 0))
    })
  }

  const countTrickplayFrames = (dir) => {
    try { return fs.readdirSync(dir).filter((n) => /^\d{6}\.jpg$/.test(n)).length } catch { return 0 }
  }

  /**
   * Makes (or finds) the preview set for one file and resolves with { state, ... }:
   *   'ready' (+ dir, manifest, bytes), 'ineligible' (too short), 'failed', 'aborted' (no ffmpeg).
   * Written to a temp dir and renamed into place only once ffmpeg exited 0 and produced frames, so
   * a half-finished set can never look "ready" to a reader. The first pass decodes key frames only;
   * a file whose key-frame flags are unreliable yields nothing that way and gets one full-decode retry.
   */
  async function generateTrickplaySet(filePath) {
    let st
    try { st = fs.statSync(filePath) } catch { return { state: 'failed' } }
    const exe = getFfmpeg()
    if (!exe) return { state: 'aborted' }
    const tracksInfo = await prober.probe(filePath)
    if (!tracksInfo) return { state: 'failed' }
    const durationSec = tracksInfo.durationSec
    if (!trickplay.isEligible(durationSec)) return { state: 'ineligible' }
    const intervalSec = trickplay.effectiveIntervalSec(durationSec)
    const width = trickplay.DEFAULT_WIDTH
    const wanted = trickplay.countFor(durationSec, intervalSec)
    const dir = trickplayDirFor(filePath, st.size, st.mtimeMs, intervalSec, width)
    const key = path.basename(dir)
    const cached = readTrickplayManifest(dir)
    if (cached) return { state: 'ready', dir, manifest: cached, bytes: cached.bytes || 0 }
    const tmp = dir + '.part'
    partsInFlight.add(key)
    try {
      for (const keyframesOnly of [true, false]) {
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
        try { fs.mkdirSync(tmp, { recursive: true }) } catch { return { state: 'failed' } }
        const ok = await runTrickplayFfmpeg(exe, trickplay.ffmpegArgs(filePath, intervalSec, width, path.join(tmp, '%06d.jpg'), { keyframesOnly }))
        const have = countTrickplayFrames(tmp)
        // A key-frame pass that found fewer than half the frames means the file's key frames are too
        // sparse (or mis-flagged) to trust: decode everything instead.
        if (!ok || have < 1 || (keyframesOnly && have < Math.ceil(wanted / 2))) continue
        try {
          const count = wanted
          trickplayCache.fillTail(tmp, have, count)
          const bytes = trickplayCache.dirBytes(tmp)
          const manifest = { intervalSec, width, count, durationSec, generatedAt: Date.now(), identity: trickplay.identityFor(filePath, st.size, st.mtimeMs), bytes, keyframesOnly }
          fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest))
          try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
          fs.renameSync(tmp, dir)
          pruneTrickplayCache(key)
          return { state: 'ready', dir, manifest, bytes }
        } catch { break }
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      return { state: 'failed' }
    } finally {
      partsInFlight.delete(key)
    }
  }

  /**
   * The state of a file's preview strip right now - never waits for ffmpeg to finish, only for
   * the (fast, cached) duration probe:
   *   'unavailable' - too short, no ffmpeg on this PC, or the owner switched previews off
   *   'generating'  - a pass just started (or one was already running); nothing to serve yet
   *   'ready'       - manifest + dir are the cached frames, safe to read from immediately
   */
  async function trickplayManifestFor(filePath) {
    if (!trickplayEnabled()) return { state: 'unavailable', disabled: true }
    let st
    try { st = fs.statSync(filePath) } catch { return { state: 'unavailable' } }
    const tracksInfo = await prober.probe(filePath)
    const durationSec = tracksInfo ? tracksInfo.durationSec : 0
    if (!trickplay.isEligible(durationSec) || !getFfmpeg()) return { state: 'unavailable' }
    const intervalSec = trickplay.effectiveIntervalSec(durationSec)
    const width = trickplay.DEFAULT_WIDTH
    const dir = trickplayDirFor(filePath, st.size, st.mtimeMs, intervalSec, width)
    const manifest = readTrickplayManifest(dir)
    if (manifest) {
      trickplayCache.touch(dir)
      return { state: 'ready', manifest, dir }
    }
    const identity = trickplay.identityFor(filePath, st.size, st.mtimeMs)
    const fresh = !trickplayQueue.has(identity)
    const running = trickplayQueue.enqueue(identity, () => generateTrickplaySet(filePath), { urgent: true })
    if (fresh) running.then((r) => log(r && r.state === 'ready' ? `trickplay ready: ${filePath}` : `trickplay generation skipped/failed: ${filePath}`))
    return { state: 'generating', intervalSec, width }
  }

  function trickplayFrameFile(dir, manifest, t) {
    const index = trickplay.frameIndexFor(t, manifest.intervalSec, manifest.count)
    if (index < 0) return null
    const file = path.join(dir, trickplay.frameFileName(index))
    return fs.existsSync(file) ? file : null
  }

  async function trickplayInfo(kind, id) {
    const filePath = await resolveFile(kind, id)
    if (!filePath) return { status: 404, body: { ok: false, error: 'not_found' } }
    const r = await trickplayManifestFor(filePath)
    if (r.state === 'unavailable') return { status: 200, body: { ok: true, available: false, ...(r.disabled ? { disabled: true } : {}) } }
    if (r.state === 'generating') return { status: 200, body: { ok: true, available: false, generating: true, intervalSec: r.intervalSec } }
    const mt = sign(id)
    return {
      status: 200,
      body: {
        ok: true, available: true, generating: false,
        intervalSec: r.manifest.intervalSec, count: r.manifest.count, width: r.manifest.width,
        // The caller appends "&t=<seconds>" for each frame it wants.
        thumbUrl: `/trickplay/thumb?kind=${kind}&id=${encodeURIComponent(id)}&mt=${mt}`
      }
    }
  }

  /**
   * Starts the background sweep that makes previews for the whole library while the house is quiet.
   * `isBusy` says whether anyone is watching / converting; `listItems` is the library ([{ path }]).
   */
  function startTrickplaySweep({ isBusy, listItems, startDelayMs, intervalMs } = {}) {
    if (typeof isBusy === 'function') houseBusy = isBusy
    if (trickplaySweep || typeof listItems !== 'function') return trickplaySweep
    trickplaySweep = trickplayJob.createTrickplaySweep({
      store,
      queue: trickplayQueue,
      listItems,
      generate: (filePath) => generateTrickplaySet(filePath),
      readyIdentities: () => new Set(trickplayCache.listSets(trickplayCacheRoot).map((s) => s.manifest && s.manifest.identity).filter(Boolean)),
      usedBytes: () => trickplayCache.totalBytes(trickplayCacheRoot),
      maxBytes: trickplayMaxBytes,
      statFile: (p) => { try { const s = fs.statSync(p); return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null } catch { return null } },
      identityOf: trickplay.identityFor,
      enabled: () => trickplayEnabled() && !!getFfmpeg(),
      log,
      ...(startDelayMs != null ? { startDelayMs } : {}),
      ...(intervalMs != null ? { intervalMs } : {})
    })
    trickplaySweep.start()
    return trickplaySweep
  }

  function trickplayStatus() {
    return {
      enabled: trickplayEnabled(),
      cacheBytes: trickplayCache.totalBytes(trickplayCacheRoot),
      cacheLimitBytes: trickplayMaxBytes(),
      queue: trickplayQueue.status(),
      sweep: trickplaySweep ? trickplaySweep.status() : null
    }
  }

  // What a conversion should use right now: { encoder, label, hardware, chain, tonemap, tonemapMethods,
  // devices, audio, tried, note }. Cached by encoderCapabilities (memory + settings store, re-probed
  // when the ffmpeg file changes); the owner's Settings choice (transcodeEncoder: '' = Automatic,
  // 'software', or an encoder to prefer) is applied on top every time, so changing it is instant.
  let lastLogged = ''
  function encoder() {
    const exe = getFfmpeg()
    if (!exe) return Promise.resolve({ encoder: null, label: '', hardware: false, chain: [], devices: {}, tonemap: false, tonemapMethods: [], tried: [], audio: { aac: false, ac3: false, eac3: false } })
    const mode = setting('transcodeEncoder', '')
    const p = runEncoderProbe
      ? runEncoderProbe({ ffmpegPath: exe, ...(mode && hls.ENCODER_CANDIDATES.includes(mode) ? { candidates: [mode, ...hls.ENCODER_CANDIDATES.filter((e) => e !== mode)] } : {}) })
      : encoders.selection({ mode })
    return p.then((sel) => {
      const line = sel.encoder ? `live conversion will use ${sel.encoder}${sel.chain && sel.chain.length > 1 ? ` (then ${sel.chain.slice(1).join(', ')} if it fails)` : ''}` : 'no working H.264 encoder found - live conversion is off'
      if (line !== lastLogged) { lastLogged = line; log(line) }
      // Live TV (liveTv/liveHls.js) reports an encoder that died / delivered through these: kept
      // off the enumerable fields so the object still serialises cleanly.
      Object.defineProperty(sel, 'noteFailure', { value: (id, why) => encoders.noteFailure(id, why), enumerable: false, configurable: true, writable: true })
      Object.defineProperty(sel, 'noteSuccess', { value: (id) => encoders.noteSuccess(id), enumerable: false, configurable: true, writable: true })
      return sel
    })
  }
  const transcodeEnabled = () => setting('transcodeEnabled', true) !== false
  // Direct play / direct stream / transcode negotiation and the HDR-preserving remux. Kept in its own module.
  const homeTheater = homeTheaterModule.createHomeTheater({
    store, log, fileAndTracks, sign, hls,
    startTranscode: (body, userId) => start(body, userId),
    getFfmpeg, getFfprobe, tmpRoot,
    audioEncoders: async () => { try { return (await encoder()).audio || null } catch { return null } },
    awayQualityCapHeight,
    ...(spawnFn ? { spawnFn } : {}),
    ...(managerOptions && managerOptions.remux ? { remuxOptions: managerOptions.remux } : {})
  })

  // ---------------------------------------------------------------- prefs
  const prefsKey = (userId, profile) => (profile ? `${userId}:${String(profile).slice(0, 64)}` : String(userId))
  function getPrefs(userId, profile) {
    const all = setting('playbackPrefs', {}) || {}
    const p = all[prefsKey(userId, profile)] || (profile ? all[String(userId)] : null) || {}
    return {
      quality: QUALITY_PREFS.has(p.quality) ? p.quality : 'auto',
      audioLanguage: typeof p.audioLanguage === 'string' ? p.audioLanguage : '',
      subtitleLanguage: typeof p.subtitleLanguage === 'string' ? p.subtitleLanguage : '',
      subtitlesOn: !!p.subtitlesOn,
      subtitleStyle: subtitleStyle.read(p.subtitleStyle),
      ...audioPrefs.read(p)
    }
  }
  function setPrefs(userId, profile, patch) {
    const all = { ...(setting('playbackPrefs', {}) || {}) }
    const cur = getPrefs(userId, profile)
    const next = { ...cur }
    if (patch && QUALITY_PREFS.has(patch.quality)) next.quality = patch.quality
    if (patch && typeof patch.audioLanguage === 'string') next.audioLanguage = tracksLib.languageCode(patch.audioLanguage).slice(0, 16)
    if (patch && typeof patch.subtitleLanguage === 'string') next.subtitleLanguage = tracksLib.languageCode(patch.subtitleLanguage).slice(0, 16)
    if (patch && typeof patch.subtitlesOn === 'boolean') next.subtitlesOn = patch.subtitlesOn
    if (patch && 'subtitleStyle' in patch) next.subtitleStyle = subtitleStyle.patch(cur.subtitleStyle, patch.subtitleStyle)
    Object.assign(next, audioPrefs.patch(cur, patch))
    all[prefsKey(userId, profile)] = next
    // Keep the map bounded: a few hundred users/profiles at most.
    const keys = Object.keys(all)
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete all[k]
    try { store.set('playbackPrefs', all) } catch {}
    return next
  }

  // -------------------------------------------------------------- versions
  // Which file of a film a person opens first: their remembered pick (movieVersionChoices, per
  // user+profile, keyed by the film's group key so it survives a rename of the primary), else the
  // best one that plays without conversion under their quality preference and the household cap.
  async function versionsInfo(kind, id, userId, profile, prefs) {
    // the whole-library sweeps ("system:..." viewers) only want tracks, not a file picker
    if (kind !== 'movie' || typeof versionsFor !== 'function' || String(userId).startsWith('system:')) return null
    let g = null
    try { g = await versionsFor(kind, id) } catch { g = null }
    if (!g || !Array.isArray(g.versions) || g.versions.length < 2) return null
    const rows = await Promise.all(g.versions.map(async (v) => {
      const row = { ...v, isCurrent: v.id === id }
      try {
        const fp = await resolveFile('movie', v.id)
        if (fp) row.direct = directVerdicts(await prober.probe(fp), path.extname(fp).toLowerCase())
      } catch {}
      return row
    }))
    const mine = (setting('movieVersionChoices', {}) || {})[prefsKey(userId, profile)] || {}
    return { versions: rows, preferredVersionId: movieVersions.preferredVersion(rows, { remembered: mine[g.groupKey], prefs, capHeight: awayQualityCapHeight() }), groupKey: g.groupKey }
  }
  async function setVersionChoice(userId, profile, id, versionId) {
    let g = null
    try { g = typeof versionsFor === 'function' ? await versionsFor('movie', id) : null } catch { g = null }
    if (!g || (versionId && !g.versions.some((v) => v.id === versionId))) return { status: 404, body: { ok: false, error: 'not_found' } }
    try { store.set('movieVersionChoices', movieVersions.rememberChoice(setting('movieVersionChoices', {}), prefsKey(userId, profile), g.groupKey, versionId)) } catch {}
    const now = await versionsInfo('movie', id, userId, profile, getPrefs(userId, profile))
    return { status: 200, body: { ok: true, preferredVersionId: now ? now.preferredVersionId : versionId || null } }
  }

  // ----------------------------------------------------------------- info
  async function fileAndTracks(kind, id) {
    const filePath = await resolveFile(kind, id)
    if (!filePath) return { error: 'not_found' }
    const tracks = await prober.probe(filePath)
    return { filePath, tracks }
  }

  async function info(kind, id, userId, profile, req) {
    const { filePath, tracks, error } = await fileAndTracks(kind, id)
    if (error) return { status: 404, body: { ok: false, error } }
    const mt = sign(id)
    const enc = await encoder()
    const ext = path.extname(filePath).toLowerCase()
    let sidecars = []
    try { sidecars = listSidecars(kind, id) || [] } catch { sidecars = [] }
    const q = (s) => encodeURIComponent(s)
    const subtitles = []
    sidecars.forEach((t, i) => subtitles.push({
      key: `side:${i}`, source: 'sidecar', kind: 'text', label: t.label || 'Subtitles', language: t.lang || '',
      forced: /forced/i.test(t.label || ''), aiGenerated: /AI-generated/.test(t.label || ''), url: `/subtitles/file?kind=${kind}&id=${q(id)}&i=${i}&mt=${mt}`
    }))
    for (const s of (tracks && tracks.subtitles) || []) {
      if (s.kind === 'unsupported') continue
      subtitles.push({
        key: `emb:${s.streamIndex}`, source: 'embedded', kind: s.kind, label: s.label, language: s.language,
        streamIndex: s.streamIndex, ordinal: s.ordinal, codec: s.codec, forced: s.forced, hearingImpaired: s.hearingImpaired,
        url: s.kind === 'text' ? `/subtitles/embedded?kind=${kind}&id=${q(id)}&s=${s.streamIndex}&mt=${mt}` : ''
      })
    }
    const transcodeOk = transcodeEnabled() && !!enc.encoder && !!(tracks && tracks.durationSec > 0 && tracks.video)
    const ver = await versionsInfo(kind, id, userId, profile, getPrefs(userId, profile))
    let markers = null
    if (typeof markersFor === 'function') {
      try { markers = markersFor(kind, id, tracks ? tracks.durationSec : 0) || null } catch { markers = null }
    }
    return {
      status: 200,
      body: {
        ok: true,
        kind, id,
        durationSec: tracks ? tracks.durationSec : 0,
        bitrateKbps: tracks ? (tracks.bitrateKbps || (tracks.video && tracks.video.bitrateKbps) || null) : null,
        video: tracks && tracks.video ? {
          codec: tracks.video.codec, width: tracks.video.width, height: tracks.video.height, fps: tracks.video.fps, hdr: tracks.video.hdr,
          // Precise picture facts (mediaClassify.js): HDR10 / HDR10+ / HLG / Dolby Vision, the profile, bit depth, colour.
          profile: tracks.video.profile, level: tracks.video.level, hdrType: tracks.video.hdrType, hdrFormats: tracks.video.hdrFormats, hdr10Plus: tracks.video.hdr10Plus,
          dolbyVision: tracks.video.dolbyVision ? { profile: tracks.video.dolbyVision.profile, label: tracks.video.dolbyVision.label, level: tracks.video.dolbyVision.level, compatId: tracks.video.dolbyVision.compatId, baseLooksLike: tracks.video.dolbyVision.baseLooksLike, elPresent: tracks.video.dolbyVision.elPresent } : null,
          bitDepth: tracks.video.bitDepth, resolutionClass: tracks.video.resolutionClass, colorPrimaries: tracks.video.colorPrimaries, colorTransfer: tracks.video.colorTransfer, colorSpace: tracks.video.colorSpace, hdrBase: tracks.video.hdrBase, badges: tracks.video.badges
        } : null,
        original: { label: originalLabel(tracks), height: tracks && tracks.video ? tracks.video.height : null },
        direct: directVerdicts(tracks, ext),
        qualities: hls.qualitiesFor(tracks && tracks.video),
        transcode: {
          available: transcodeOk,
          encoder: enc.encoder || '',
          encoderLabel: enc.label || '',
          hardware: !!enc.hardware,
          // How HDR films are turned into normal colours at a lower quality ('none' = they may look dull).
          toneMap: (enc.tonemapMethods && enc.tonemapMethods[0]) || (enc.tonemap ? 'zscale' : 'none'),
          reason: transcodeOk ? '' : !transcodeEnabled() ? 'Live conversion is switched off on the PC.'
            : !getFfmpeg() ? 'The converter (ffmpeg) is not installed on the PC.'
            : !enc.encoder ? 'The PC has no working video encoder.'
            : 'This file could not be read for conversion.'
        },
        audio: ((tracks && tracks.audio) || []).map((a) => ({
          ordinal: a.ordinal, streamIndex: a.streamIndex, label: a.label, language: a.language, codec: a.codec, channels: a.channels, title: a.title, isDefault: a.isDefault,
          channelLayout: a.channelLayout || null, profile: a.profile || null, playsAs: hlsAudio.describeSourceTrack(a),
          // What the track is (mediaClassify.js): "Dolby TrueHD + Dolby Atmos", 7.1, lossless, object audio.
          formatName: a.formatName || null, family: a.family || null, layout: a.layout || null, lossless: !!a.lossless, objectAudio: a.objectAudio || null, spatialFormat: a.spatialFormat || 'None'
        })),
        audioOptions: {
          modes: hlsAudio.AUDIO_MODES,
          downmixes: hlsAudio.DOWNMIXES,
          delayLimitMs: hlsAudio.DELAY_LIMIT_MS,
          boostLimitDb: hlsAudio.BOOST_LIMIT_DB,
          encoders: enc.audio || { aac: true, ac3: false, eac3: false },
          surroundAvailable: transcodeOk && ((tracks && tracks.audio) || []).some((a) => Number(a.channels) >= 5),
          normalizeNote: hlsAudio.NORMALIZE_NOTE
        },
        subtitles,
        chapters: (tracks && tracks.chapters) || [],
        prefs: getPrefs(userId, profile),
        onlineSearch: { configured: subtitleClient.configured() },
        // Advisory only (see awayQualityCapHeight() above) - the client combines this with its own
        // "am I away from home right now" check to explain/self-limit "Original" in the quality
        // sheet. streamServer.js's /file and /tvfile routes enforce the real cap independently.
        awayQualityCapHeight: awayQualityCapHeight(),
        ...(markers ? { markers } : {}),
        // Badges, precise format and the plan (direct play / direct stream / transcode, with reasons) for THIS device.
        homeTheater: homeTheater.infoBlock({ tracks, filePath, userId, headers: req && req.headers }),
        ...(ver ? { versions: ver.versions, preferredVersionId: ver.preferredVersionId } : {})
      }
    }
  }

  // ---------------------------------------------------------------- start
  async function start(body, userId) {
    const kind = body && body.kind === 'tv' ? 'tv' : 'movie'
    const id = String((body && body.id) || '')
    const quality = String((body && body.quality) || '')
    if (!id || !hls.QUALITIES[quality]) return { status: 400, body: { ok: false, error: 'bad_request' } }
    if (!transcodeEnabled()) return { status: 409, body: { ok: false, error: 'transcode_off', message: 'Live conversion is switched off on the PC.' } }
    const { filePath, tracks, error } = await fileAndTracks(kind, id)
    if (error) return { status: 404, body: { ok: false, error } }
    if (!tracks || !tracks.video || !(tracks.durationSec > 0)) return { status: 422, body: { ok: false, error: 'unreadable', message: 'This file could not be read for conversion.' } }
    const enc = await encoder()
    if (!enc.encoder) return { status: 409, body: { ok: false, error: 'no_encoder', message: 'The PC cannot convert video (no ffmpeg or encoder).' } }

    let audio = null
    if (body.audio != null && body.audio !== '') {
      const a = tracks.audio.find((x) => x.streamIndex === Number(body.audio))
      if (!a) return { status: 400, body: { ok: false, error: 'bad_audio' } }
      audio = a.streamIndex
    }
    let burn = null
    if (body.burnSubtitle != null && body.burnSubtitle !== '') {
      const s = tracks.subtitles.find((x) => x.streamIndex === Number(body.burnSubtitle))
      if (!s || s.kind !== 'image') return { status: 400, body: { ok: false, error: 'bad_subtitle', message: 'Only picture subtitles are burnt in; text subtitles stay separate.' } }
      burn = s.streamIndex
    }
    const owner = String(userId)
    // Over the limit: the viewer joins a first-come-first-served line (no time estimate - nobody can
    // honestly say how long a film will take) and keeps their place while their player asks again
    // every few seconds. A place held for someone who was let in is theirs for a short while.
    const slot = manager.admit(owner, `${kind}|${id}`)
    if (!slot.ok) {
      const next = slot.position <= 1
      return {
        status: 503,
        body: {
          ok: false, error: 'busy', queued: true, position: slot.position, waiting: slot.waiting, retryAfterSec: 5,
          message: `The server is busy right now, converting video for other people. ${next ? "You're next in line" : `You're number ${slot.position} in line`} - keep this open and it will start by itself, or choose Original quality to play straight away.`
        }
      }
    }
    const audioRequest = hlsAudio.normalizeAudioRequest(body)
    const au = hlsAudio.ticketAudio(audioRequest)
    const ticket = hls.makeTicket(sign, au ? { k: kind, i: id, q: quality, a: audio, s: burn, u: owner, au } : { k: kind, i: id, q: quality, a: audio, s: burn, u: owner })
    const plan = hls.audioPlanFor({ tracks, quality, audioStreamIndex: audio, audio: au, audioEncoders: enc.audio })
    const size = hls.outputSize(tracks.video.width, tracks.video.height, quality)
    return {
      status: 200,
      body: {
        ok: true,
        url: `/hls/${ticket}/index.m3u8`,
        ticket,
        mimeType: 'application/x-mpegURL',
        quality,
        height: size && size.height > 0 ? size.height : hls.QUALITIES[quality].height,
        videoKbps: hls.QUALITIES[quality].videoKbps,
        encoder: enc.encoder,
        encoderLabel: enc.label,
        audio,
        audioPlan: { ...hlsAudio.describeAudio(plan), kind: plan.kind, codec: plan.codec, channels: plan.channels, mixedDown: !!plan.mixedDown, surround: !!plan.surround, bitrateKbps: plan.bitrateKbps },
        burnSubtitle: burn,
        durationSec: tracks.durationSec
      }
    }
  }

  // ------------------------------------------------------- online search
  async function onlineSearch(kind, id, lang, userId, profile) {
    if (!subtitleClient.configured()) return { status: 200, body: { ok: false, error: 'not_configured', message: 'Subtitle search is not set up yet. Ask the owner to set up subtitle search on the PC (Settings > Subtitles).', results: [] } }
    const filePath = await resolveFile(kind, id)
    if (!filePath) return { status: 404, body: { ok: false, error: 'not_found' } }
    const language = tracksLib.twoLetter(lang || getPrefs(userId, profile).subtitleLanguage || 'en') || 'en'
    const terms = searchTermsFor(kind, id, decodeId, filePath)
    const moviehash = await openSubs.computeHash(filePath)
    try {
      let results = await subtitleClient.search({ moviehash, query: terms.query, year: kind === 'movie' ? terms.year : null, season: terms.season, episode: terms.episode, languages: language, type: terms.type })
      if (!results.length && moviehash) {
        results = await subtitleClient.search({ query: terms.query, year: kind === 'movie' ? terms.year : null, season: terms.season, episode: terms.episode, languages: language, type: terms.type })
      }
      return { status: 200, body: { ok: true, language, searchedFor: terms, results: results.slice(0, 40) } }
    } catch (e) {
      return { status: 200, body: { ok: false, error: e.code || 'failed', message: e.message, results: [] } }
    }
  }

  async function onlineDownload(body) {
    if (!subtitleClient.configured()) return { status: 200, body: { ok: false, error: 'not_configured', message: 'Subtitle search is not set up yet. Ask the owner to set up subtitle search on the PC.' } }
    const kind = body && body.kind === 'tv' ? 'tv' : 'movie'
    const id = String((body && body.id) || '')
    const filePath = id ? await resolveFile(kind, id) : null
    if (!filePath) return { status: 404, body: { ok: false, error: 'not_found' } }
    try {
      const got = await subtitleClient.download(body.fileId)
      if (!openSubs.looksLikeSubtitle(got.data)) return { status: 200, body: { ok: false, error: 'bad_file', message: 'That download was not a subtitle file.' } }
      const ext = /\.vtt$/i.test(got.fileName) ? 'vtt' : 'srt'
      const lang = tracksLib.twoLetter(body.lang) || 'und'
      const saved = openSubs.writeSidecar(filePath, lang, got.data, { hearingImpaired: !!body.hearingImpaired, forced: !!body.forced, ext })
      if (!saved) return { status: 200, body: { ok: false, error: 'no_name', message: 'There are already too many subtitle files for this video.' } }
      log(`saved downloaded subtitles as ${path.basename(saved)}`)
      let index = -1
      try {
        const list = listSidecars(kind, id) || []
        const stem = path.basename(saved).toLowerCase()
        index = list.findIndex((t) => t.absFile && path.basename(t.absFile).toLowerCase() === stem)
      } catch {}
      return { status: 200, body: { ok: true, savedAs: path.basename(saved), key: index >= 0 ? `side:${index}` : '', remaining: got.remaining, resetTime: got.resetTime } }
    } catch (e) {
      return { status: 200, body: { ok: false, error: e.code || 'failed', message: e.message } }
    }
  }

  // --------------------------------------------------------- dispatcher
  /**
   * Signed-in routes. `p` is the path without its /api or /playback-api prefix. Returns false
   * when the path isn't one of ours.
   */
  async function handle(req, res, p, url, { userId, send }) {
    const method = req.method || 'GET'
    const profile = url.searchParams.get('profile') || String(req.headers['x-beebo-profile'] || '') || ''
    const reply = (r) => send(r.status, r.body)
    if (p === '/playback/info' && method === 'GET') {
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const id = url.searchParams.get('id') || ''
      if (!id) { send(400, { ok: false, error: 'bad_request' }); return true }
      reply(await info(kind, id, userId, profile, req))
      return true
    }
    if (p === '/playback/negotiate' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body) { send(400, { ok: false, error: 'bad_request' }); return true }
      const r = await homeTheater.negotiate(body, { userId, headers: req.headers })
      if (r.status === 503 && r.body && r.body.retryAfterSec) res.setHeader('Retry-After', String(r.body.retryAfterSec))
      reply(r)
      return true
    }
    if (p === '/playback/hometheater' && method === 'GET') {
      const prof = homeTheater.profileFor({ headers: req.headers })
      send(200, { ok: true, profile: { client: prof.client, source: prof.source, summary: require('./deviceProfile').describeProfile(prof) }, settings: homeTheater.settings.forUser(userId), remux: { available: !!getFfmpeg() && !!getFfprobe() } })
      return true
    }
    if (p === '/playback/start' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body) { send(400, { ok: false, error: 'bad_request' }); return true }
      reply(await start(body, userId))
      return true
    }
    if (p === '/playback/stop' && method === 'POST') {
      const body = await readJsonBody(req)
      const t = body && hls.readTicket(verify, body.ticket)
      if (t && String(t.fields.u) === String(userId)) {
        if (t.fields.rx) homeTheater.close(t.sessionKey)
        manager.close(t.sessionKey)
        manager.leaveLine(String(userId), `${t.fields.k === 'tv' ? 'tv' : 'movie'}|${t.fields.i}`)
      }
      send(200, { ok: true })
      return true
    }
    if (p === '/playback/prefs') {
      if (method === 'GET') { send(200, { ok: true, prefs: getPrefs(userId, profile) }); return true }
      if (method === 'POST') {
        const body = await readJsonBody(req)
        if (!body) { send(400, { ok: false, error: 'bad_request' }); return true }
        send(200, { ok: true, prefs: setPrefs(userId, body.profile || profile, body) })
        return true
      }
    }
    if (p === '/playback/version' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body || !body.id) { send(400, { ok: false, error: 'bad_request' }); return true }
      reply(await setVersionChoice(userId, body.profile || profile, String(body.id), String(body.versionId || '')))
      return true
    }
    if (p === '/playback/speedtest' && method === 'GET') {
      const kb = Math.min(8192, Math.max(16, parseInt(url.searchParams.get('kb') || '1024', 10) || 1024))
      const buf = crypto.randomBytes(kb * 1024)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
      res.end(buf)
      return true
    }
    if (p === '/playback/trickplay/info' && method === 'GET') {
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const id = url.searchParams.get('id') || ''
      if (!id) { send(400, { ok: false, error: 'bad_request' }); return true }
      reply(await trickplayInfo(kind, id))
      return true
    }
    if (p === '/playback/status' && method === 'GET') {
      const enc = await encoder()
      send(200, { ok: true, enabled: transcodeEnabled(), encoder: enc.encoder, encoderLabel: enc.label, hardware: enc.hardware, tried: enc.tried, chain: enc.chain || [], maxConcurrent: manager.maxConcurrent(), running: manager.size(), load: manager.load() })
      return true
    }
    if (p === '/subtitles/online' && method === 'GET') {
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const id = url.searchParams.get('id') || ''
      if (!id) { send(400, { ok: false, error: 'bad_request' }); return true }
      reply(await onlineSearch(kind, id, url.searchParams.get('lang') || '', userId, profile))
      return true
    }
    if (p === '/subtitles/online/download' && method === 'POST') {
      const body = await readJsonBody(req)
      if (!body) { send(400, { ok: false, error: 'bad_request' }); return true }
      reply(await onlineDownload(body))
      return true
    }
    return false
  }

  // ------------------------------------------------ ticket / token routes
  const HLS_RE = /^\/hls\/([A-Za-z0-9_.-]{10,2048})\/(index\.m3u8|master\.m3u8|init\.mp4|seg-(\d{1,6})\.(?:ts|m4s))$/
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Expose-Headers': 'Content-Length' }

  /** Returns true when it answered the request. Called before the login gate. */
  async function handlePublic(req, res, url) {
    const p = url.pathname
    const method = req.method || 'GET'
    // hls.js served from this PC (electron/vendor), so the web player needs no outside site.
    if (p === '/hls/hls.min.js' && (method === 'GET' || method === 'HEAD')) {
      fs.readFile(path.join(__dirname, 'vendor', 'hls.min.js'), (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return }
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' })
        res.end(method === 'HEAD' ? undefined : buf)
      })
      return true
    }
    if (p.startsWith('/hls/')) {
      if (method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return true }
      const m = HLS_RE.exec(p)
      const t = m ? hls.readTicket(verify, m[1]) : null
      if (!t) { res.writeHead(403, { 'Content-Type': 'text/plain', ...corsHeaders }); res.end('Forbidden'); return true }
      const f = t.fields
      // A direct-stream ticket (fragmented MP4, picture copied): hlsRemux.js through homeTheater.js.
      if (f.rx) return homeTheater.handleRemux(req, res, t, m[2], corsHeaders)
      // The live conversion only makes index.m3u8 and .ts pieces.
      if (m[2] === 'master.m3u8' || m[2] === 'init.mp4' || m[2].endsWith('.m4s')) { res.writeHead(404, corsHeaders); res.end('Not found'); return true }
      const kind = f.k === 'tv' ? 'tv' : 'movie'
      let session = manager.get(t.sessionKey)
      if (!session) {
        const { filePath, tracks, error } = await fileAndTracks(kind, String(f.i || ''))
        if (error || !tracks) { res.writeHead(404, corsHeaders); res.end('Not found'); return true }
        const enc = await encoder()
        if (!enc.encoder || !transcodeEnabled()) { res.writeHead(409, corsHeaders); res.end('Conversion unavailable'); return true }
        try {
          session = manager.open({
            key: t.sessionKey, owner: String(f.u || ''), fileKey: `${kind}|${f.i}`, filePath, tracks,
            quality: f.q, encoder: enc.encoder, chain: enc.chain, devices: enc.devices, tonemap: enc.tonemap, tonemapMethods: enc.tonemapMethods, audioStreamIndex: f.a, burnSubtitleStreamIndex: f.s,
            audio: f.au && typeof f.au === 'object' ? f.au : null, audioEncoders: enc.audio || null
          })
        } catch (e) {
          const busy = e && e.code === 'busy'
          res.writeHead(busy ? 503 : 500, { 'Content-Type': 'text/plain', 'Retry-After': '10', ...corsHeaders })
          res.end(busy ? e.message : 'Conversion failed')
          return true
        }
      }
      if (m[2] === 'index.m3u8') {
        const text = manager.playlist(session)
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store', ...corsHeaders })
        res.end(method === 'HEAD' ? undefined : text)
        return true
      }
      let hungUp = false
      res.once('close', () => { hungUp = true })
      // A piece that takes a while (the first one after a seek on a slow encoder) must not trip
      // the phone's read timeout or the tunnel's 30 s wait for an answer: after a few seconds the
      // headers go out, then an MPEG-TS null packet (ignored by every player) every few seconds
      // until the piece is ready.
      let keepAlive = null
      let headersSent = false
      if (method !== 'HEAD') {
        keepAlive = setInterval(() => {
          if (hungUp) return
          if (!headersSent) {
            headersSent = true
            res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'private, max-age=3600', ...corsHeaders })
          }
          res.write(TS_NULL_PACKET)
        }, keepAliveMs)
      }
      let file
      try {
        file = await manager.segment(session, Number(m[3]))
      } catch (e) {
        clearInterval(keepAlive)
        if (hungUp) return true
        if (headersSent) res.destroy()
        else { res.writeHead(500, { 'Content-Type': 'text/plain', ...corsHeaders }); res.end('Conversion failed') }
        return true
      } finally {
        clearInterval(keepAlive)
      }
      if (hungUp) return true
      let data = null
      try { data = file ? fs.readFileSync(file) : null } catch { data = null }
      if (!data) {
        if (headersSent) res.destroy()
        else { res.writeHead(404, corsHeaders); res.end('Not found') }
        return true
      }
      if (headersSent) { res.end(data); return true }
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=3600', ...corsHeaders })
      res.end(method === 'HEAD' ? undefined : data)
      return true
    }
    if (p === '/trickplay/thumb') {
      if (method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return true }
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const id = url.searchParams.get('id') || ''
      const token = url.searchParams.get('mt') || String(req.headers[mediaTokenHeader] || '')
      if (!verify(id, token)) { res.writeHead(403, corsHeaders); res.end('Forbidden'); return true }
      const filePath = await resolveFile(kind, id)
      if (!filePath) { res.writeHead(404, corsHeaders); res.end('Not found'); return true }
      const r = await trickplayManifestFor(filePath)
      if (r.state !== 'ready') {
        const body = JSON.stringify({ ok: false, generating: r.state === 'generating' })
        res.writeHead(202, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...corsHeaders })
        res.end(method === 'HEAD' ? undefined : body)
        return true
      }
      const file = trickplayFrameFile(r.dir, r.manifest, Number(url.searchParams.get('t') || '0'))
      let data
      try { data = file ? fs.readFileSync(file) : null } catch { data = null }
      if (!data) { res.writeHead(404, corsHeaders); res.end('Not found'); return true }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=86400', ...corsHeaders })
      res.end(method === 'HEAD' ? undefined : data)
      return true
    }
    if (p === '/subtitles/embedded') {
      if (method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return true }
      const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie'
      const id = url.searchParams.get('id') || ''
      const token = url.searchParams.get('mt') || String(req.headers[mediaTokenHeader] || '')
      if (!verify(id, token)) { res.writeHead(403, corsHeaders); res.end('Forbidden'); return true }
      const streamIndex = Number(url.searchParams.get('s'))
      const { filePath, tracks, error } = await fileAndTracks(kind, id)
      const sub = !error && tracks ? tracks.subtitles.find((s) => s.streamIndex === streamIndex) : null
      if (!sub || sub.kind !== 'text') { res.writeHead(404, corsHeaders); res.end('Not found'); return true }
      const out = await extractor.extract(filePath, streamIndex)
      let data
      try { data = out ? fs.readFileSync(out) : null } catch { data = null }
      if (!data) { res.writeHead(500, corsHeaders); res.end('Could not read these subtitles'); return true }
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=3600', ...corsHeaders })
      res.end(method === 'HEAD' ? undefined : data)
      return true
    }
    return false
  }

  // Warm the encoder probe shortly after start so the first "720p" doesn't wait for it.
  const warm = setTimeout(() => { encoder().catch(() => {}) }, 8000)
  if (warm.unref) warm.unref()

  return {
    handle,
    handlePublic,
    info,
    start,
    getPrefs,
    setPrefs,
    encoder,
    manager,
    // Direct play / direct stream / transcode negotiation (homeTheater.js): settings store, remux sessions, plan builder.
    homeTheater,
    // Settings > Hardware acceleration and the dashboard's "Transcode load" read these.
    encoderService: encoders,
    transcodeLoad: () => manager.load(),
    subtitleClient,
    testOpenSubtitles: () => subtitleClient.test(),
    // Exposed so subtitleSweep.js can drive the whole-library sweep through the
    // exact same search/download code the single-title "Search online" button
    // uses (dispatcher `handle` above calls these same two closures) - never a
    // second copy of the OpenSubtitles request/rate-limit logic.
    onlineSearch,
    onlineDownload,
    startTrickplaySweep,
    trickplayStatus,
    close: () => { clearTimeout(warm); trickplayQueue.stop(); if (trickplaySweep) trickplaySweep.stop(); manager.closeAll(); homeTheater.closeAll() }
  }
}

/** Redact HLS tickets from logged URLs (they work like media tokens). */
function redactTickets(text) {
  return String(text).replace(/(\/hls\/)[A-Za-z0-9_.-]{10,}(\/)/g, '$1[redacted]$2')
}

module.exports = { createPlaybackApi, directVerdicts, originalLabel, searchTermsFor, readJsonBody, redactTickets, isBrowserPlayable }
