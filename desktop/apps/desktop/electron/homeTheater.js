'use strict'
// ============================================================================
// homeTheater.js - the server side of "tell me what you can play, and I will pick the best way".
// ----------------------------------------------------------------------------
// playbackApi.js stays small and forwards here. This module owns:
//
//   info block     GET /playback/info gets `homeTheater`: the file's precise format (badges, HDR type, Dolby
//                  Vision profile, Atmos / DTS:X ...) and the plan for the CALLING device (its declared profile,
//                  else the platform default from its User-Agent).
//   negotiate      POST /playback/negotiate { kind, id, deviceProfile?, client?, audio?, quality?, subtitle?,
//                  maxBitrateKbps? } -> the plan (method, per-stream actions, machine-readable reasons) AND the
//                  URL to play it:
//                    DirectPlay    the original file (/file, /tvfile: HTTP range requests, no ffmpeg)
//                    DirectStream  /hls/<ticket>/master.m3u8: fragmented MP4 HLS, picture copied (hlsRemux.js)
//                    Transcode     the existing live conversion (hlsTranscoder.js) with the sound decided here
//   remux routes   /hls/<ticket>/master.m3u8, index.m3u8, init.mp4, seg-<n>.m4s for remux tickets.
//
// A remux that cannot start (no key frame index yet, no ffmpeg, too many at once) never leaves a client without
// a picture: the plan is redone as a Transcode and says why.
// ============================================================================

const fs = require('fs')
const os = require('os')
const path = require('path')
const dp = require('./deviceProfile')
const decision = require('./playbackDecision')
const remux = require('./hlsRemux')
const hlsAudio = require('./hlsAudio')
const classify = require('./mediaClassify')
const htSettings = require('./homeTheaterSettings')

const INDEX_WAIT_MS = 8000

const RX_TAGS = new Set(['avc1', 'hvc1', 'dvh1'])

/** The compact remux request that rides in a ticket (signed, so a client cannot invent one). */
function rxFromPlan(plan, tracks) {
  const audio = plan.audio || {}
  const rx = { a: audio.streamIndex != null ? audio.streamIndex : null, ac: audio.action === 'copy' ? 'copy' : audio.action === 'transcode' ? 'encode' : 'none', t: plan.video.tag || 'avc1' }
  if (plan.video.dvStrip) rx.s = 1
  if (audio.action === 'transcode' && audio.request) {
    const au = hlsAudio.ticketAudio(hlsAudio.normalizeAudioRequest(audio.request))
    if (au) rx.au = au
  }
  if (audio.codec) rx.ad = audio.codec
  if (audio.channels) rx.ch = audio.channels
  rx.hr = remux.videoRangeOf(plan.video.hdr && plan.video.hdr.delivered)
  if (plan.video.hdr && plan.video.hdr.action === 'keep' && tracks.video && tracks.video.dolbyVision) rx.dv = 1
  return rx
}

/** Reads a ticket's `rx` back, tolerating anything. */
function readRx(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    a: Number.isInteger(r.a) ? r.a : null,
    ac: r.ac === 'copy' ? 'copy' : r.ac === 'none' ? 'none' : 'encode',
    t: RX_TAGS.has(r.t) ? r.t : 'avc1',
    s: r.s === 1 ? 1 : 0,
    au: r.au && typeof r.au === 'object' ? r.au : null,
    ad: ['aac', 'ac3', 'eac3'].includes(r.ad) ? r.ad : '',
    ch: Number.isInteger(r.ch) ? Math.max(1, Math.min(16, r.ch)) : 0,
    hr: ['PQ', 'HLG', 'SDR'].includes(r.hr) ? r.hr : 'SDR',
    dv: r.dv === 1 ? 1 : 0
  }
}

function createHomeTheater({
  store,
  log = () => {},
  fileAndTracks,        // async (kind, id) => { filePath, tracks, error }
  sign,                 // (id) => media token
  hls,                  // hlsTranscoder module (makeTicket / readTicket)
  startTranscode,       // async (body, userId) => { status, body } (playbackApi.start)
  getFfmpeg,
  getFfprobe,
  audioEncoders,        // async () => { aac, ac3, eac3 }
  awayQualityCapHeight = () => null,
  tmpRoot = path.join(os.tmpdir(), 'beebo-playback'),
  spawnFn,
  remuxOptions = {},
  indexWaitMs = INDEX_WAIT_MS,
  keyframeIndex: injectedIndex = null // tests
}) {
  const settingsStore = htSettings.createStore(store)
  const keyframeIndex = injectedIndex || remux.createKeyframeIndex({ ffprobePath: getFfprobe, cacheDir: path.join(tmpRoot, 'keyframes') })
  const manager = remux.createRemuxManager({
    ffmpegPath: getFfmpeg,
    keyframeIndex,
    tmpRoot: path.join(tmpRoot, 'remux'),
    log,
    ...(spawnFn ? { spawnFn } : {}),
    ...remuxOptions
  })
  const remuxAvailable = () => !!getFfmpeg() && !!getFfprobe()
  const hdr = (headers, name) => { try { const v = headers && (typeof headers.get === 'function' ? headers.get(name) : headers[name]); return v == null ? '' : String(v) } catch { return '' } }

  /**
   * The device profile of a request: the client's declaration (body.deviceProfile: an object, JSON, or base64url JSON; or the
   * X-Beebo-Device-Profile header), laid over the default for its platform (body.client / X-Beebo-Client, else the User-Agent).
   * A bare word instead of a declaration ("appletv") just names the platform.
   */
  function profileFor({ headers, body } = {}) {
    let client = String((body && body.client) || hdr(headers, 'x-beebo-client') || '')
    const d = body && body.deviceProfile != null ? body.deviceProfile : hdr(headers, 'x-beebo-device-profile')
    let declared = null
    if (d && typeof d === 'object') declared = d
    else if (typeof d === 'string' && d.trim()) {
      declared = dp.parseDeclaration(d)
      if (!declared && !client) client = d.trim().slice(0, 32)
    }
    return dp.resolveProfile({ declared, client, userAgent: hdr(headers, 'user-agent') })
  }

  function requestFrom(body, tracks) {
    const b = body || {}
    const out = {}
    if (b.audio != null && b.audio !== '') out.audioStreamIndex = Number(b.audio)
    else if (b.audioStreamIndex != null) out.audioStreamIndex = Number(b.audioStreamIndex)
    if (typeof b.quality === 'string') out.quality = b.quality
    if (Number(b.maxBitrateKbps) > 0) out.maxBitrateKbps = Math.min(1000000, Math.round(Number(b.maxBitrateKbps)))
    const subIndex = b.subtitle != null && typeof b.subtitle === 'object' ? b.subtitle.streamIndex : b.burnSubtitle != null && b.burnSubtitle !== '' ? b.burnSubtitle : b.subtitle
    if (subIndex != null && subIndex !== '' && Number.isFinite(Number(subIndex))) {
      const s = ((tracks && tracks.subtitles) || []).find((x) => x.streamIndex === Number(subIndex))
      if (s) out.subtitle = { streamIndex: s.streamIndex, codec: s.codec, kind: s.kind }
    }
    const cap = awayQualityCapHeight()
    if (b.awayFromHome === true && cap) out.awayCapHeight = cap
    return out
  }

  function planFor({ tracks, filePath, profile, userId, body, remuxOk = true }) {
    return decision.decide({
      tracks, ext: path.extname(filePath || '').toLowerCase(), profile,
      settings: settingsStore.forUser(userId),
      request: requestFrom(body, tracks),
      remuxAvailable: remuxOk && remuxAvailable()
    })
  }

  // ------------------------------------------------------------------ info
  /** The `homeTheater` block of GET /playback/info. Pure apart from starting the key frame scan in the background. */
  function infoBlock({ tracks, filePath, userId, headers }) {
    // The whole-library sweeps (subtitleSweep: 'system:...' viewers, no request) only want tracks: no plan, and above all no key frame scan of every film.
    if (!tracks || String(userId || '').startsWith('system:')) return null
    const c = classify.classifyProbe(tracks.raw, { frameSideData: tracks.frameSideData })
    const profile = profileFor({ headers })
    const plan = planFor({ tracks, filePath, profile, userId })
    // Warm the key frame index while the viewer looks at the page: a direct stream then starts at once.
    if (plan.method === 'DirectStream' && tracks.video && headers) { try { keyframeIndex.get(filePath, tracks.video.streamIndex) } catch { /* optional */ } }
    return {
      badges: c ? c.badges : [],
      objectAudio: c ? c.objectAudio : [],
      video: c && c.video ? {
        resolutionClass: c.video.resolutionClass, bitDepth: c.video.bitDepth, hdrType: c.video.hdrType, hdrFormats: c.video.hdrFormats, hdr10Plus: c.video.hdr10Plus,
        dolbyVision: c.video.dolbyVision ? { profile: c.video.dolbyVision.profile, label: c.video.dolbyVision.label, level: c.video.dolbyVision.level, compatId: c.video.dolbyVision.compatId, baseLooksLike: c.video.dolbyVision.baseLooksLike, elPresent: c.video.dolbyVision.elPresent } : null,
        colorPrimaries: c.video.colorPrimaries, colorTransfer: c.video.colorTransfer, colorSpace: c.video.colorSpace, chroma: c.video.chroma
      } : null,
      audio: c ? c.audio.map((a) => ({ streamIndex: a.streamIndex, codec: a.codec, name: a.name, family: a.family, layout: a.layout, lossless: a.lossless, objectAudio: a.objectAudio, spatialFormat: a.spatialFormat, inferred: a.inferred, badges: a.badges })) : [],
      profile: { client: profile.client, source: profile.source, summary: dp.describeProfile(profile) },
      plan,
      settings: settingsStore.forUser(userId),
      remux: { available: remuxAvailable() }
    }
  }

  // ------------------------------------------------------------- negotiate
  const directUrl = (kind, id) => `${kind === 'tv' ? '/tvfile' : '/file'}?id=${encodeURIComponent(id)}&mt=${encodeURIComponent(sign(id))}`

  async function negotiate(body, { userId, headers } = {}) {
    const kind = body && body.kind === 'tv' ? 'tv' : 'movie'
    const id = String((body && body.id) || '')
    if (!id) return { status: 400, body: { ok: false, error: 'bad_request' } }
    const { filePath, tracks, error } = await fileAndTracks(kind, id)
    if (error) return { status: 404, body: { ok: false, error } }
    if (!tracks || !tracks.video) return { status: 422, body: { ok: false, error: 'unreadable', message: 'This file could not be read.' } }
    const profile = profileFor({ headers, body })
    let plan = planFor({ tracks, filePath, profile, userId, body })
    const owner = String(userId)

    if (plan.method === 'DirectStream') {
      const kf = await keyframeIndex.wait(filePath, tracks.video.streamIndex, Number(body && body.waitMs) >= 0 ? Math.min(60000, Number(body.waitMs)) : indexWaitMs)
      if (kf.state === 'scanning') {
        return { status: 503, body: { ok: false, error: 'preparing', retryAfterSec: 3, plan, message: 'Getting this film ready to stream without converting it. Try again in a moment (a big film is read once, then it starts at once).' } }
      }
      if (kf.state !== 'ready') {
        log(`direct stream not possible for ${path.basename(filePath)} (${kf.error || 'no key frame index'}) - converting instead`)
        plan = planFor({ tracks, filePath, profile, userId, body, remuxOk: false })
        plan.reasons.push({ stream: 'session', code: 'REMUX_UNAVAILABLE', text: 'The picture could not be prepared for a direct stream on this computer -> converting the picture', severity: 'info', fatal: true })
        plan.reasonCodes.push('REMUX_UNAVAILABLE')
      } else if (!(kf.keyframes[0] <= 1.5)) {
        // The first picture is not a key frame (a recording cut mid-stream): fragments would not line up with the index.
        log(`direct stream not possible for ${path.basename(filePath)} (it does not start on a key frame) - converting instead`)
        plan = planFor({ tracks, filePath, profile, userId, body, remuxOk: false })
        plan.reasons.push({ stream: 'session', code: 'REMUX_UNAVAILABLE', text: 'The film does not start on a key frame, so it cannot be repackaged cleanly -> converting the picture', severity: 'info', fatal: true })
        plan.reasonCodes.push('REMUX_UNAVAILABLE')
      } else {
        const rx = rxFromPlan(plan, tracks)
        const ticket = hls.makeTicket(sign, { k: kind, i: id, u: owner, rx })
        return {
          status: 200,
          body: {
            ok: true, method: 'DirectStream', plan, url: `/hls/${ticket}/master.m3u8`, ticket, mimeType: 'application/x-mpegURL',
            durationSec: tracks.durationSec, container: 'hls-fmp4',
            video: { codec: tracks.video.codec, tag: rx.t, hdr: plan.video.hdr.delivered }, audio: plan.audio
          }
        }
      }
    }

    if (plan.method === 'DirectPlay') {
      return { status: 200, body: { ok: true, method: 'DirectPlay', plan, url: directUrl(kind, id), mimeType: mimeOf(filePath), durationSec: tracks.durationSec, container: plan.container.source } }
    }

    // Transcode: the live conversion, with the sound the plan decided (copy when the device plays it).
    const start = { kind, id, quality: plan.video.quality || '1080p' }
    if (plan.audio && plan.audio.streamIndex != null) start.audio = plan.audio.streamIndex
    if (plan.subtitles && plan.subtitles.action === 'burn' && body) {
      const s = requestFrom(body, tracks).subtitle
      if (s) start.burnSubtitle = s.streamIndex
    }
    if (plan.audio && plan.audio.request) Object.assign(start, plan.audio.request)
    const r = await startTranscode(start, userId)
    if (r.status !== 200) return { status: r.status, body: { ...r.body, plan } }
    return { status: 200, body: { ...r.body, method: 'Transcode', plan, container: 'hls-ts' } }
  }

  // ---------------------------------------------------------- remux routes
  /**
   * /hls/<ticket>/<file> for a ticket that carries `rx`. Returns true when it answered.
   *   t = hls.readTicket() result, name = master.m3u8 | index.m3u8 | init.mp4 | seg-<n>.m4s
   */
  async function handleRemux(req, res, t, name, cors) {
    const method = req.method || 'GET'
    const f = t.fields
    const kind = f.k === 'tv' ? 'tv' : 'movie'
    const send = (status, headers, body) => { res.writeHead(status, { ...cors, ...headers }); res.end(method === 'HEAD' ? undefined : body) }
    let s = manager.get(t.sessionKey)
    const { filePath, tracks, error } = s ? { filePath: s.filePath, tracks: s.tracks, error: null } : await fileAndTracks(kind, String(f.i || ''))
    if (error || !tracks || !tracks.video) { send(404, { 'Content-Type': 'text/plain' }, 'Not found'); return true }
    const rx = readRx(f.rx)
    if (name === 'master.m3u8') {
      const bw = Math.max(2000000, Math.round(((tracks.bitrateKbps || (tracks.video.bitrateKbps || 8000)) * 1000) * 1.1))
      const text = remux.buildMasterPlaylist({ video: tracks.video, dvKept: !!rx.dv, range: rx.hr, audioCodec: rx.ad, audioChannels: '', bandwidth: bw })
      send(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' }, text)
      return true
    }
    if (!s) {
      const kf = await keyframeIndex.wait(filePath, tracks.video.streamIndex, 0)
      if (kf.state !== 'ready') { send(503, { 'Content-Type': 'text/plain', 'Retry-After': '3' }, 'Not ready'); return true }
      try {
        s = manager.open({ key: t.sessionKey, owner: String(f.u || ''), fileKey: `${kind}|${f.i}`, filePath, tracks, keyframes: kf.keyframes, rx, audioEncoders: await audioEncoders() })
      } catch (e) {
        const busy = e && e.code === 'busy'
        send(busy ? 503 : 500, { 'Content-Type': 'text/plain', 'Retry-After': '10' }, busy ? e.message : 'Could not start')
        return true
      }
    }
    try {
      if (name === 'index.m3u8') {
        const text = manager.playlist(s)
        send(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' }, text)
        return true
      }
      if (name === 'init.mp4') {
        const buf = await manager.initSegment(s)
        send(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=3600' }, buf)
        return true
      }
      const m = /^seg-(\d{1,6})\.m4s$/.exec(name)
      if (!m) { send(404, { 'Content-Type': 'text/plain' }, 'Not found'); return true }
      const file = await manager.segment(s, Number(m[1]))
      let data = null
      try { data = file ? fs.readFileSync(file) : null } catch { data = null }
      if (!data) { send(404, { 'Content-Type': 'text/plain' }, 'Not found'); return true }
      send(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'Cache-Control': 'private, max-age=3600' }, data)
      return true
    } catch (e) {
      log(`remux ${t.sessionKey}: ${String((e && e.message) || e)}`)
      send(500, { 'Content-Type': 'text/plain' }, 'Repackaging failed')
      return true
    }
  }

  return {
    infoBlock,
    negotiate,
    handleRemux,
    profileFor,
    planFor,
    settings: settingsStore,
    manager,
    keyframeIndex,
    close: (key) => { if (key) manager.close(key) },
    closeAll: () => manager.closeAll(),
    remuxLoad: () => manager.load()
  }
}

function mimeOf(filePath) {
  const e = path.extname(String(filePath || '')).toLowerCase()
  return { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.avi': 'video/x-msvideo' }[e] || 'application/octet-stream'
}

module.exports = { createHomeTheater, rxFromPlan, readRx, mimeOf, INDEX_WAIT_MS }
