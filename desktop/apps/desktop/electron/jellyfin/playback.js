'use strict'

const crypto = require('crypto')
const path = require('path')
const { toTicks, sendText, sendEmpty, pick } = require('./util')
const classify = require('../mediaClassify') // VideoRangeType, AudioSpatialFormat

const INFO_TTL_MS = 30 * 1000
const PLAY_SESSION_CAP = 2000
const QUALITY_HEIGHT = { '1080p': 1080, '720p': 720, '480p': 480 }

const csv = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

const CONTAINER_ALIASES = {
  mkv: ['mkv', 'matroska'],
  webm: ['webm', 'matroska'],
  mp4: ['mp4', 'm4v'],
  m4v: ['m4v', 'mp4'],
  mov: ['mov', 'mp4'],
  wmv: ['wmv', 'asf'],
  ts: ['ts', 'mpegts'],
  m2ts: ['m2ts', 'mpegts', 'ts'],
  avi: ['avi']
}

const LANG3 = { en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ja: 'jpn', ko: 'kor', zh: 'zho', ru: 'rus', nl: 'nld', pl: 'pol', sv: 'swe', ar: 'ara', hi: 'hin', tr: 'tur' }
const lang3 = (l) => {
  const s = String(l || '').toLowerCase()
  if (!s) return undefined
  return s.length === 2 ? (LANG3[s] || s) : s.slice(0, 3)
}

function conditionHolds(cond, value) {
  if (value === null || value === undefined || value === '') return true
  const c = String(cond.Condition || '')
  const want = String(cond.Value || '')
  const n = Number(value)
  const w = Number(want)
  switch (c) {
    case 'LessThanEqual': return !(Number.isFinite(n) && Number.isFinite(w)) || n <= w
    case 'GreaterThanEqual': return !(Number.isFinite(n) && Number.isFinite(w)) || n >= w
    case 'Equals': return String(value).toLowerCase() === want.toLowerCase()
    case 'NotEquals': return String(value).toLowerCase() !== want.toLowerCase()
    case 'EqualsAny': return want.toLowerCase().split('|').includes(String(value).toLowerCase())
    default: return true
  }
}

function codecProfilesAllow(profile, type, codec, props) {
  for (const cp of (profile && profile.CodecProfiles) || []) {
    if (cp.Type !== type) continue
    const codecs = csv(cp.Codec)
    if (codecs.length && codec && !codecs.includes(codec)) continue
    for (const cond of cp.Conditions || []) {
      if (!conditionHolds(cond, props[cond.Property])) {
        return false
      }
    }
  }
  return true
}

function profileAllowsDirect(profile, { container, vcodec, acodec, width, height, bitrate, channels }) {
  const names = CONTAINER_ALIASES[container] || [container]
  const ok = ((profile && profile.DirectPlayProfiles) || []).some((p) => {
    if (p.Type && p.Type !== 'Video') return false
    const cs = csv(p.Container)
    if (cs.length && !cs.some((c) => names.includes(c))) return false
    const vs = csv(p.VideoCodec)
    if (vs.length && vcodec && !vs.includes(vcodec)) return false
    const as = csv(p.AudioCodec)
    if (as.length && acodec && !as.includes(acodec)) return false
    return true
  })
  if (!ok) return false
  if (!codecProfilesAllow(profile, 'Video', vcodec, { Width: width, Height: height, VideoBitrate: bitrate })) return false
  if (!codecProfilesAllow(profile, 'VideoAudio', acodec, { AudioChannels: channels })) return false
  return true
}

const CUE_TIME = /^((?:\d{1,2}:)?\d{2}:\d{2})\.(\d{3})\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2})\.(\d{3})/
const srtClock = (hms, ms) => (hms.split(':').length === 2 ? '00:' + hms : hms.replace(/^(\d):/, '0$1:')) + ',' + ms

function vttToSrt(vtt) {
  let n = 0
  const out = []
  for (const line of String(vtt).replace(/^\uFEFF?WEBVTT[^\n]*\n+/, '').split(/\r?\n/)) {
    const m = CUE_TIME.exec(line)
    if (m) {
      out.push(String(++n))
      out.push(srtClock(m[1], m[2]) + ' --> ' + srtClock(m[3], m[4]))
    } else if (!/^(NOTE|STYLE|REGION)\b/.test(line)) out.push(line)
  }
  return out.join('\n')
}

function createPlayback({ host, ids, auth, catalog, mapper, services }) {
  const infoCache = new Map()
  const playSessions = new Map()

  const kindOf = (entry) => (entry.type === 'Episode' ? 'tv' : 'movie')
  const extOf = (entry) => {
    try { return path.extname(Buffer.from(String(entry.beeboId), 'base64url').toString('utf8')).slice(1).toLowerCase() } catch { return '' }
  }
  const tokenOf = (entry) => {
    const m = /[?&]mt=([^&]+)/.exec(entry.stream || '')
    return m ? decodeURIComponent(m[1]) : ''
  }

  async function beeboInfo(user, entry, req) {
    const key = user.id + '|' + entry.jid
    const hit = infoCache.get(key)
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.value
    const r = await host.api(user.id, 'GET', '/api/playback/info?kind=' + kindOf(entry) + '&id=' + encodeURIComponent(entry.beeboId), undefined, req)
    const value = r && r.status === 200 && r.body && r.body.ok ? r.body : null
    infoCache.set(key, { at: Date.now(), value })
    if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value)
    return value
  }

  function buildStreams(entry, info) {
    const streams = []
    if (info && info.video) {
      const v = info.video
      const dv = v.dolbyVision || null
      // Jellyfin's VideoRangeType (SDR | HDR10 | HDR10Plus | HLG | DOVI | DOVIWithHDR10 | DOVIWithHLG | DOVIWithSDR | DOVIWithEL ...).
      const rangeType = classify.jellyfinVideoRangeType({
        hdr: !!v.hdr, hdr10Plus: !!v.hdr10Plus, dolbyVision: dv,
        hdrBase: v.hdrBase || ((v.hdrFormats || []).includes('HDR10') ? 'PQ' : (v.hdrFormats || []).includes('HLG') ? 'HLG' : (v.hdr ? 'PQ' : 'SDR'))
      })
      const res = v.resolutionClass || (v.height ? v.height + 'p' : '')
      const hdrWord = v.hdrType && v.hdrType !== 'SDR' ? (dv && dv.label ? 'Dolby Vision ' + dv.label + (v.hdrFormats && v.hdrFormats.includes('HDR10') ? ' / HDR10' : '') : v.hdrType) : ''
      streams.push({
        Codec: v.codec, TimeBase: '1/1000', VideoRange: v.hdr ? 'HDR' : 'SDR', VideoRangeType: rangeType,
        DisplayTitle: [res, String(v.codec || '').toUpperCase(), hdrWord].filter(Boolean).join(' '),
        IsInterlaced: false, BitRate: info.bitrateKbps ? Math.round(info.bitrateKbps * 1000) : undefined, Height: v.height || undefined, Width: v.width || undefined,
        AverageFrameRate: v.fps || undefined, RealFrameRate: v.fps || undefined, IsDefault: true, IsForced: false, Type: 'Video', Index: 0,
        IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: false, PixelFormat: undefined, Level: v.level || 0,
        Profile: v.profile || undefined, BitDepth: v.bitDepth || undefined, ColorPrimaries: v.colorPrimaries || undefined, ColorTransfer: v.colorTransfer || undefined, ColorSpace: v.colorSpace || undefined,
        ...(dv ? {
          VideoDoViTitle: 'Dolby Vision Profile ' + (dv.label || dv.profile), DvVersionMajor: 1, DvVersionMinor: 0, DvProfile: dv.profile, DvLevel: dv.level || undefined,
          RpuPresentFlag: 1, ElPresentFlag: dv.elPresent ? 1 : 0, BlPresentFlag: 1, DvBlSignalCompatibilityId: dv.compatId != null ? dv.compatId : undefined
        } : {})
      })
    }
    for (const a of (info && info.audio) || []) {
      streams.push({
        Codec: a.codec, Language: lang3(a.language), DisplayTitle: a.label, Title: a.title || undefined, IsInterlaced: false, IsDefault: !!a.isDefault, IsForced: false,
        Type: 'Audio', Index: a.streamIndex, Channels: a.channels || undefined, IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: false,
        Profile: a.profile || undefined, ChannelLayout: a.layout || a.channelLayout || undefined,
        // 'None' | 'DolbyAtmos' | 'DTSX' (Jellyfin 10.10): Atmos in E-AC-3 or TrueHD, DTS:X.
        AudioSpatialFormat: a.spatialFormat || 'None'
      })
    }
    ;((info && info.subtitles) || []).forEach((s, i) => {
      const embedded = s.source === 'embedded'
      const index = embedded ? s.streamIndex : 1000 + i
      const text = s.kind === 'text'
      streams.push({
        Codec: text ? 'webvtt' : (s.codec || 'pgssub'), Language: lang3(s.language), DisplayTitle: s.label, IsInterlaced: false, IsDefault: false, IsForced: !!s.forced,
        Type: 'Subtitle', Index: index, IsExternal: !embedded, IsTextSubtitleStream: text, SupportsExternalStream: text,
        DeliveryMethod: text ? 'External' : 'Encode', DeliveryUrl: text ? '/Videos/' + entry.jid + '/' + entry.jid + '/Subtitles/' + index + '/0/Stream.vtt' : undefined
      })
    })
    return streams
  }

  function sourceBase(entry, info) {
    const streams = buildStreams(entry, info)
    const defAudio = streams.find((s) => s.Type === 'Audio' && s.IsDefault) || streams.find((s) => s.Type === 'Audio')
    return {
      Protocol: 'File',
      Id: entry.jid,
      Type: 'Default',
      Container: extOf(entry) || undefined,
      Name: entry.title,
      IsRemote: false,
      ETag: mapper.tagOf(entry.jid + '|src'),
      RunTimeTicks: info && info.durationSec ? toTicks(info.durationSec) : undefined,
      ReadAtNativeFramerate: false, // (sic: the public API spells it this way)
      HasSegments: true, // the app may ask /MediaSegments/{id}; it answers with the intro/credits markers, or an empty list
      IgnoreDts: false,
      IgnoreIndex: false,
      GenPtsInput: false,
      SupportsTranscoding: true,
      SupportsDirectStream: true,
      SupportsDirectPlay: true,
      IsInfiniteStream: false,
      RequiresOpening: false,
      RequiresClosing: false,
      RequiresLooping: false,
      SupportsProbing: true,
      VideoType: 'VideoFile',
      MediaStreams: streams,
      MediaAttachments: [],
      Formats: [],
      Bitrate: info && info.bitrateKbps ? Math.round(info.bitrateKbps * 1000) : undefined,
      RequiredHttpHeaders: {},
      DefaultAudioStreamIndex: defAudio ? defAudio.Index : undefined
    }
  }

  async function mediaSourcesFor(user, entry, req) {
    if (entry.type === 'Audio') {
      return {
        runtimeSec: entry.duration || 0,
        sources: [{
          Protocol: 'File', Id: entry.jid, Type: 'Default', Container: entry.codec || undefined, Name: entry.title, IsRemote: false, SupportsTranscoding: true, SupportsDirectStream: true, SupportsDirectPlay: true,
          RunTimeTicks: entry.duration ? toTicks(entry.duration) : undefined, Bitrate: entry.bitrate || undefined, RequiredHttpHeaders: {}, Formats: [], MediaAttachments: [],
          MediaStreams: [{ Codec: entry.codec, Type: 'Audio', Index: 0, IsDefault: true, IsForced: false, IsExternal: false, Channels: entry.channels || undefined, SampleRate: entry.sampleRate || undefined, BitRate: entry.bitrate || undefined, DisplayTitle: String(entry.codec || '').toUpperCase() }]
        }]
      }
    }
    const info = await beeboInfo(user, entry, req)
    return { runtimeSec: info ? info.durationSec : 0, sources: [sourceBase(entry, info)], info }
  }

  function chooseQuality(info, maxBitrate, requestedHeight) {
    const list = (info && info.qualities) || [{ id: '1080p', videoKbps: 8000, audioKbps: 192, upscale: false }, { id: '720p', videoKbps: 4000, audioKbps: 160, upscale: false }, { id: '480p', videoKbps: 1500, audioKbps: 128, upscale: false }]
    const ok = list.filter((q) => !q.upscale || q.id === '480p')
    const fits = (q) => (!maxBitrate || (q.videoKbps + q.audioKbps) * 1000 <= maxBitrate) && (!requestedHeight || QUALITY_HEIGHT[q.id] <= requestedHeight)
    const pickQ = ok.find(fits) || ok[ok.length - 1] || list[list.length - 1]
    return pickQ.id
  }

  function decide({ info, entry, profile, opts }) {
    const ext = extOf(entry)
    const haveProbe = !!(info && info.video)
    const audio = ((info && info.audio) || [])
    const chosenAudio = opts.audioStreamIndex !== undefined ? audio.find((a) => a.streamIndex === opts.audioStreamIndex) : (audio.find((a) => a.isDefault) || audio[0])
    const sub = opts.subtitleStreamIndex >= 0 ? ((info && info.subtitles) || []).find((s, i) => (s.source === 'embedded' ? s.streamIndex : 1000 + i) === opts.subtitleStreamIndex) : null
    const needBurn = !!(sub && sub.kind === 'image')
    let direct
    if (opts.enableDirectPlay === false || opts.forceTranscode) direct = false
    else if (needBurn) direct = false
    else if (info && info.awayQualityCapHeight && info.video && info.video.height > info.awayQualityCapHeight) direct = false
    else if (haveProbe) {
      const bitrate = info.bitrateKbps ? info.bitrateKbps * 1000 : undefined
      if (opts.maxStreamingBitrate && bitrate && bitrate > opts.maxStreamingBitrate) direct = false
      else if (profile && Array.isArray(profile.DirectPlayProfiles) && profile.DirectPlayProfiles.length) {
        direct = profileAllowsDirect(profile, { container: ext, vcodec: info.video.codec, acodec: chosenAudio ? chosenAudio.codec : undefined, width: info.video.width, height: info.video.height, bitrate, channels: chosenAudio ? chosenAudio.channels : undefined })
        if (direct && info.direct && info.direct.android === false && !/^(mkv|mp4|m4v|mov|webm)$/.test(ext)) direct = false
      } else direct = !!(info.direct && info.direct.android)
    } else {
      direct = /^(mp4|m4v|webm|mov)$/.test(ext) && (!profile || !profile.DirectPlayProfiles || profileAllowsDirect(profile, { container: ext }))
    }
    const transcodeOk = !!(info && info.transcode && info.transcode.available)
    return { direct, transcodeOk, needBurn, chosenAudio, sub }
  }

  function transcodingUrl(entry, token, { deviceId, playSessionId, audioIndex, subtitleIndex, quality, needBurn }) {
    const params = new URLSearchParams()
    if (deviceId) params.set('DeviceId', deviceId)
    params.set('MediaSourceId', entry.jid)
    params.set('VideoCodec', 'h264')
    params.set('AudioCodec', 'aac')
    if (audioIndex !== undefined) params.set('AudioStreamIndex', String(audioIndex))
    if (subtitleIndex !== undefined && subtitleIndex >= 0) {
      params.set('SubtitleStreamIndex', String(subtitleIndex))
      params.set('SubtitleMethod', needBurn ? 'Encode' : 'External')
    }
    params.set('Quality', quality)
    params.set('PlaySessionId', playSessionId)
    params.set('api_key', token)
    params.set('TranscodingMaxAudioChannels', '2')
    params.set('SegmentContainer', 'ts')
    params.set('MinSegments', '1')
    params.set('BreakOnNonKeyFrames', 'True')
    return '/Videos/' + entry.jid + '/master.m3u8?' + params.toString()
  }

  function rememberPlaySession(rec) {
    playSessions.delete(rec.id)
    playSessions.set(rec.id, rec)
    if (playSessions.size > PLAY_SESSION_CAP) playSessions.delete(playSessions.keys().next().value)
  }

  async function playbackInfo(user, entry, { req, body, q, token, device }) {
    const playSessionId = crypto.randomBytes(16).toString('hex')
    const status = await host.api(user.id, 'GET', '/api/parental/status', undefined, req)
    if (status && status.status === 200 && status.body && status.body.canWatchNow === false) {
      return { MediaSources: [], PlaySessionId: playSessionId, ErrorCode: 'NotAllowed' }
    }
    const profile = pick(body, 'DeviceProfile') || null
    const opts = {
      maxStreamingBitrate: Number(pick(body, 'MaxStreamingBitrate') || q('maxStreamingBitrate')) || (profile && Number(profile.MaxStreamingBitrate)) || 0,
      audioStreamIndex: pick(body, 'AudioStreamIndex') !== undefined ? Number(pick(body, 'AudioStreamIndex')) : (q.has('audioStreamIndex') ? q.int('audioStreamIndex') : undefined),
      subtitleStreamIndex: pick(body, 'SubtitleStreamIndex') !== undefined ? Number(pick(body, 'SubtitleStreamIndex')) : (q.has('subtitleStreamIndex') ? q.int('subtitleStreamIndex') : -1),
      enableDirectPlay: pick(body, 'EnableDirectPlay') !== undefined ? pick(body, 'EnableDirectPlay') !== false : (q.has('enableDirectPlay') ? q.bool('enableDirectPlay') : true),
      enableTranscoding: pick(body, 'EnableTranscoding') !== undefined ? pick(body, 'EnableTranscoding') !== false : true,
      forceTranscode: false
    }
    if (entry.type === 'Audio') {
      const s = (await mediaSourcesFor(user, entry, req)).sources[0]
      s.DirectStreamUrl = '/Audio/' + entry.jid + '/universal?api_key=' + encodeURIComponent(token) + '&MediaSourceId=' + entry.jid
      rememberPlaySession({ id: playSessionId, userId: user.id, jid: entry.jid })
      return { MediaSources: [s], PlaySessionId: playSessionId }
    }
    const info = await beeboInfo(user, entry, req)
    const src = sourceBase(entry, info)
    const verdict = decide({ info, entry, profile, opts })
    src.SupportsDirectPlay = !!verdict.direct
    src.SupportsDirectStream = !!verdict.direct
    const wantTranscode = !verdict.direct && opts.enableTranscoding !== false
    src.SupportsTranscoding = verdict.transcodeOk || !info
    if (verdict.direct) {
      src.DirectStreamUrl = '/Videos/' + entry.jid + '/stream?Static=true&MediaSourceId=' + entry.jid + '&api_key=' + encodeURIComponent(token) + '&Tag=' + src.ETag
    } else if (wantTranscode) {
      const quality = chooseQuality(info, opts.maxStreamingBitrate, 0)
      src.TranscodingUrl = transcodingUrl(entry, token, { deviceId: device.id, playSessionId, audioIndex: verdict.chosenAudio ? verdict.chosenAudio.streamIndex : undefined, subtitleIndex: opts.subtitleStreamIndex, quality, needBurn: verdict.needBurn })
      src.TranscodingSubProtocol = 'hls'
      src.TranscodingContainer = 'ts'
      src.Bitrate = undefined
    }
    if (!verdict.direct && !wantTranscode) return { MediaSources: [], PlaySessionId: playSessionId, ErrorCode: 'NoCompatibleStream' }
    if (opts.subtitleStreamIndex >= 0) src.DefaultSubtitleStreamIndex = opts.subtitleStreamIndex
    rememberPlaySession({ id: playSessionId, userId: user.id, jid: entry.jid, durationSec: info ? info.durationSec : 0 })
    return { MediaSources: [src], PlaySessionId: playSessionId }
  }

  function m3u8Master(bandwidth, resolution, uri) {
    return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-STREAM-INF:BANDWIDTH=' + bandwidth + (resolution ? ',RESOLUTION=' + resolution : '') + ',CODECS="avc1.640028,mp4a.40.2"', uri, ''].join('\n')
  }

  async function hlsMaster(user, entry, ctx) {
    const { req, res, q } = ctx
    const status = await host.api(user.id, 'GET', '/api/parental/status', undefined, req)
    if (status && status.status === 200 && status.body && status.body.canWatchNow === false) {
      sendText(res, 403, (status.body && status.body.message) || 'Playback is not allowed right now.', 'text/plain; charset=utf-8')
      return
    }
    const info = await beeboInfo(user, entry, req)
    const qualityWanted = q('quality')
    const quality = QUALITY_HEIGHT[qualityWanted] ? qualityWanted : chooseQuality(info, q.int('videoBitrate', 0) ? q.int('videoBitrate') + 192000 : q.int('maxStreamingBitrate', 0), q.int('maxHeight', 0))
    const body = { kind: kindOf(entry), id: entry.beeboId, quality }
    const wantedAudio = q.has('audioStreamIndex') ? q.int('audioStreamIndex') : undefined
    if (wantedAudio !== undefined && ((info && info.audio) || []).some((a) => a.streamIndex === wantedAudio)) body.audio = wantedAudio
    const sIdx = q.has('subtitleStreamIndex') ? q.int('subtitleStreamIndex', -1) : -1
    if (sIdx >= 0 && info) {
      const s = (info.subtitles || []).find((x) => x.source === 'embedded' && x.streamIndex === sIdx)
      if (s && s.kind === 'image' && !/^(external|hls|embed)$/i.test(q('subtitleMethod'))) body.burnSubtitle = sIdx
    }
    const r = await host.api(user.id, 'POST', '/api/playback/start', body, req)
    if (!r || r.status !== 200 || !r.body || !r.body.url) {
      const status = r && r.status === 503 ? 503 : r && r.status === 404 ? 404 : 500
      sendText(res, status, (r && r.body && r.body.message) || 'Playback is not available for this item.', 'text/plain; charset=utf-8', status === 503 ? { 'Retry-After': '10' } : {})
      return
    }
    const height = r.body.height || QUALITY_HEIGHT[quality]
    const ratio = info && info.video && info.video.width && info.video.height ? info.video.width / info.video.height : 16 / 9
    const width = Math.round((height * ratio) / 2) * 2
    const bandwidth = ((r.body.videoKbps || 4000) + 160) * 1000
    sendText(res, 200, m3u8Master(bandwidth, width + 'x' + height, r.body.url), 'application/vnd.apple.mpegurl')
  }

  function directPath(entry) {
    const mt = tokenOf(entry)
    if (!mt) return null
    return (entry.type === 'Episode' ? '/tvfile' : '/file') + '?id=' + encodeURIComponent(entry.beeboId) + '&mt=' + encodeURIComponent(mt)
  }

  async function subtitleStream(user, entry, index, format, ctx) {
    const { req, res } = ctx
    const info = await beeboInfo(user, entry, req)
    if (!info) { sendEmpty(res, 404); return }
    const list = info.subtitles || []
    const at = list.findIndex((s, i) => (s.source === 'embedded' ? s.streamIndex : 1000 + i) === index)
    const sub = at >= 0 ? list[at] : null
    const mt = tokenOf(entry)
    if (!sub || sub.kind !== 'text' || !mt || !sub.url) { sendEmpty(res, 404); return }
    const target = sub.url.replace(/([?&])mt=[^&]*/, '$1mt=' + encodeURIComponent(mt))
    const r = await host.api(user.id, 'GET', target, undefined, req)
    if (!r || r.status !== 200 || !r.text) { sendEmpty(res, r && r.status === 404 ? 404 : 502); return }
    let text = r.text
    let type = 'text/vtt; charset=utf-8'
    if (/^(srt|subrip)$/i.test(format)) {
      text = vttToSrt(text)
      type = 'application/x-subrip; charset=utf-8'
    }
    sendText(res, 200, text, type, { 'Cache-Control': 'private, max-age=3600' })
  }

  function audioCodecsParam(q) {
    const raw = [...q.list('container'), ...q.list('audioCodec')].map((s) => s.toLowerCase())
    const out = new Set()
    for (const c of raw) {
      if (c === 'm4a' || c === 'mp4') out.add('aac')
      else if (c === 'webma' || c === 'webm' || c === 'ogg') { out.add('opus'); out.add('vorbis') }
      else if (c === 'wav') out.add('pcm_s16le')
      else out.add(c)
    }
    return [...out].join(',')
  }

  async function audioStream(user, entry, ctx, universal) {
    const { req, res, url, q } = ctx
    const codecs = universal ? audioCodecsParam(q) : ''
    const target = '/api/music/track/' + encodeURIComponent(entry.beeboId) + '/stream' + (codecs ? '?codecs=' + encodeURIComponent(codecs) : '')
    req.url = target
    req.headers.authorization = 'Bearer ' + host.makeApiToken(host.store, user.id)
    delete req.headers['x-emby-authorization']
    await host.dispatch(req, res)
    return url
  }

  async function directStream(user, entry, ctx) {
    const { req, res } = ctx
    const target = directPath(entry)
    if (!target) { sendEmpty(res, 404); return }
    req.url = target
    await host.dispatch(req, res)
  }

  function playSession(id) { return playSessions.get(id) || null }

  return { mediaSourcesFor, playbackInfo, hlsMaster, directStream, subtitleStream, audioStream, beeboInfo, playSession, directPath, decide, profileAllowsDirect, kindOf }
}

module.exports = { createPlayback, profileAllowsDirect, codecProfilesAllow, vttToSrt, CONTAINER_ALIASES }
