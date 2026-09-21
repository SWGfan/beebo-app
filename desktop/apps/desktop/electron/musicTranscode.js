// On-the-fly audio conversion for the Music player, only when it is needed:
//   - the phone says it cannot decode the song's format (?codecs=mp3,aac,...
//     without, say, flac or alac), or
//   - a lower quality was asked for (?quality=high|medium|low), which the
//     phone does away from home to save data.
// Everything else is served as the original file, byte for byte.
//
// A converted copy is written to <cache>/music/transcoded/ first and then
// served like any other file, so Range requests and seeking work exactly as
// they do for the original (at home and over the WebRTC tunnel). The copies
// are a cache: the oldest are removed once the folder passes its size limit.
// A 5-minute song converts in a couple of seconds, which is the wait the first
// play of that song at that quality costs.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')

const QUALITY_KBPS = { high: 256, medium: 160, low: 96 }
const KNOWN_CODECS = new Set(['mp3', 'mp2', 'aac', 'alac', 'flac', 'opus', 'vorbis', 'pcm'])

function resolveFf(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name
  const candidates = [
    process.env['BEEBO_' + name.toUpperCase()],
    process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg', exe) : null,
    path.join(__dirname, '..', 'resources', 'ffmpeg', exe)
  ]
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c } catch {}
  }
  return null
}

// ?codecs=mp3,aac,flac -> Set, or null when the client did not say (assume it plays everything).
function parseCodecs(raw) {
  if (raw == null || raw === '') return null
  const set = new Set(
    String(raw).toLowerCase().split(/[\s,]+/).map((c) => (c === 'wav' ? 'pcm' : c === 'ogg' ? 'vorbis' : c)).filter((c) => KNOWN_CODECS.has(c))
  )
  return set
}

function parseQuality(raw) {
  const q = String(raw || '').toLowerCase()
  return QUALITY_KBPS[q] ? q : 'original'
}

// null = send the original. Otherwise { format: 'aac' | 'opus', kbps }.
function decide(track, { codecs, quality, format } = {}) {
  if (!track) return null
  const can = parseCodecs(codecs)
  const q = parseQuality(quality)
  const mustConvert = !!(can && !can.has(track.codec))
  const cap = QUALITY_KBPS[q] || null
  const bitrate = Number(track.bitrate) || 0
  const overCap = !!cap && (track.lossless || !bitrate || bitrate > cap * 1000 * 1.15)
  if (!mustConvert && !overCap) return null
  const wantOpus = String(format || '').toLowerCase() === 'opus' && (!can || can.has('opus'))
  let kbps = cap || 256
  // A lossy song the phone just can't decode: no point spending more bits than it has.
  if (!cap && !track.lossless && bitrate > 0) kbps = Math.max(96, Math.min(kbps, Math.round(bitrate / 1000)))
  if (wantOpus) kbps = Math.min(kbps, 192)
  return { format: wantOpus ? 'opus' : 'aac', kbps }
}

function outputName(track, plan) {
  const ext = plan.format === 'opus' ? 'ogg' : 'm4a'
  return `${track.id}-${track.size || 0}-${Math.round(track.mtimeMs || 0)}-${plan.format}${plan.kbps}.${ext}`
}

function ffmpegArgs(input, output, plan) {
  const common = ['-v', 'error', '-nostdin', '-y', ...require('./ffmpegArgs').inputArgs(input), '-map', '0:a:0', '-vn', '-sn', '-map_metadata', '-1']
  if (plan.format === 'opus') {
    return [...common, '-c:a', 'libopus', '-b:a', `${plan.kbps}k`, '-vbr', 'on', '-f', 'ogg', output]
  }
  return [...common, '-c:a', 'aac', '-b:a', `${plan.kbps}k`, '-movflags', '+faststart', '-f', 'mp4', output]
}

function createTranscoder({ getCacheRoot, ffmpegPath, log, maxCacheBytes = 2 * 1024 * 1024 * 1024, maxJobs = 2, timeoutMs = 10 * 60 * 1000 } = {}) {
  const say = typeof log === 'function' ? log : () => {}
  const ffmpeg = ffmpegPath === undefined ? resolveFf('ffmpeg') : ffmpegPath
  const inflight = new Map()
  const queue = []
  let running = 0

  const dir = () => {
    const root = typeof getCacheRoot === 'function' ? getCacheRoot() : null
    return root ? path.join(root, 'transcoded') : null
  }

  function runFfmpeg(args) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      } catch (err) {
        resolve({ ok: false, error: err.message })
        return
      }
      let stderr = ''
      child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d })
      const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, error: stderr.trim().split(/\r?\n/).pop() }) })
    })
  }

  function slot(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      pump()
    })
  }
  function pump() {
    while (running < maxJobs && queue.length) {
      const job = queue.shift()
      running++
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => { running--; pump() })
    }
  }

  async function prune(keep) {
    const d = dir()
    if (!d) return
    try {
      const names = await fsp.readdir(d)
      const files = []
      let total = 0
      for (const n of names) {
        const p = path.join(d, n)
        try {
          const st = await fsp.stat(p)
          if (!st.isFile()) continue
          files.push({ p, size: st.size, t: st.mtimeMs })
          total += st.size
        } catch {}
      }
      files.sort((a, b) => a.t - b.t)
      for (const f of files) {
        if (total <= maxCacheBytes) break
        if (f.p === keep) continue
        try { await fsp.rm(f.p, { force: true }); total -= f.size } catch {}
      }
    } catch {}
  }

  // Resolves to the converted file's path, or rejects.
  function ensure(file, plan) {
    if (!ffmpeg) return Promise.reject(Object.assign(new Error('ffmpeg is not available'), { code: 'no_ffmpeg' }))
    const d = dir()
    if (!d) return Promise.reject(Object.assign(new Error('no cache folder'), { code: 'no_cache' }))
    const out = path.join(d, outputName(file.track, plan))
    if (fs.existsSync(out)) {
      const t = new Date()
      fsp.utimes(out, t, t).catch(() => {})
      return Promise.resolve(out)
    }
    if (inflight.has(out)) return inflight.get(out)
    const p = slot(async () => {
      if (fs.existsSync(out)) return out
      await fsp.mkdir(d, { recursive: true })
      const tmp = out + '.part'
      const r = await runFfmpeg(ffmpegArgs(file.path, tmp, plan))
      if (!r.ok && plan.format === 'opus') {
        // An ffmpeg build without libopus: AAC plays everywhere. Converted here, in this same
        // job slot, so a fallback can never wait on a slot its own job is holding.
        say(`music: opus conversion failed (${r.error}); using AAC`)
        await fsp.rm(tmp, { force: true }).catch(() => {})
        const aac = { format: 'aac', kbps: plan.kbps }
        const aacOut = path.join(d, outputName(file.track, aac))
        if (fs.existsSync(aacOut)) return aacOut
        const r2 = await runFfmpeg(ffmpegArgs(file.path, aacOut + '.part', aac))
        if (!r2.ok) {
          await fsp.rm(aacOut + '.part', { force: true }).catch(() => {})
          throw Object.assign(new Error(`conversion failed: ${r2.error || 'ffmpeg error'}`), { code: 'transcode_failed' })
        }
        await fsp.rename(aacOut + '.part', aacOut)
        prune(aacOut)
        return aacOut
      }
      if (!r.ok) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw Object.assign(new Error(`conversion failed: ${r.error || 'ffmpeg error'}`), { code: 'transcode_failed' })
      }
      await fsp.rename(tmp, out)
      prune(out)
      return out
    }).finally(() => inflight.delete(out))
    inflight.set(out, p)
    return p
  }

  return { ensure, available: () => !!ffmpeg, ffmpegPath: ffmpeg }
}

module.exports = { createTranscoder, decide, parseCodecs, parseQuality, outputName, ffmpegArgs, resolveFf, QUALITY_KBPS }
