'use strict'
// ============================================================================
// phoneSpeakersServer.js - puts Phone speakers together for streamServer.js: the room manager, the audio piece manager,
// the HTTP door, and the few things they need from the server (the library, parental controls, the ffmpeg path, the LAN address).
// streamServer.js only creates this, routes /speakers/* and /phone-speakers-api/* to it, and closes it.
// ----------------------------------------------------------------------------
// Settings (the owner's, in the app's store; every one is optional):
//   phoneSpeakersEnabled      default true. Off: the pages and the API answer "switched off", no room can start.
//   phoneSpeakersAllowRemote  default false. Guests must be on the home network (localAccessPolicy.isHomeRequest).
//   phoneSpeakersQuality      'standard' (32 kHz, default) | 'high' (48 kHz)  sample rate of the pieces
//   phoneSpeakersFillIn       'tv' (default) | 'neighbour' | 'off'  what happens to a channel when its phone leaves
// ============================================================================

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ch = require('./phoneSpeakersChannels')
const audioLib = require('./phoneSpeakersAudio')
const roomsLib = require('./phoneSpeakers')
const httpLib = require('./phoneSpeakersHttp')
const tracksLib = require('./playbackTracks')

const QUALITY_RATE = { standard: ch.DEFAULT_RATE, high: 48000 }

// Addresses a phone can reach this computer on, best guess first. The first private address on the machine is often a virtual
// adapter (VirtualBox, Hyper-V, WSL, Docker, a VPN), which no phone can reach; real Wi-Fi / Ethernet come first, the rest are
// offered as "not working? try these".
const VIRTUAL_NAME = /virtualbox|vmware|vethernet|hyper-?v|wsl|docker|vpn|tap-|tun|tailscale|zerotier|loopback|bluetooth|pseudo|host-only|vboxnet|utun|awdl|llw|bridge|veth|br-/i
const PREFERRED_NAME = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wl/i
function lanCandidates(interfaces) {
  let ifaces = interfaces
  if (!ifaces) { try { ifaces = os.networkInterfaces() } catch { ifaces = {} } }
  const out = []
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal) continue
      const ip = String(a.address || '')
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) continue
      let score = 50
      if (VIRTUAL_NAME.test(name)) score -= 40
      if (/^192\.168\.(56|99|137|122)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\.(0|17)\./.test(ip)) score -= 20 // VirtualBox / libvirt / Docker defaults
      if (PREFERRED_NAME.test(name)) score += 30
      if (/^192\.168\.\d+\.\d+$/.test(ip)) score += 5
      out.push({ name, ip, score })
    }
  }
  return out.sort((x, y) => y.score - x.score)
}
/** ['http://192.168.1.20:47811', ...] best first; the port answers plain http as well as https, and a LAN phone gets no certificate warning over http. */
function lanOrigins(port, interfaces) {
  const list = lanCandidates(interfaces).map((c) => `http://${c.ip}:${port}`)
  return list.length ? list : [`http://127.0.0.1:${port}`]
}

/** Every feed worth cutting for a film (so a new preset never restarts ffmpeg); a stereo film starts with just the stereo feeds. */
function feedsFor(source) {
  const mixes = ['DL', 'DR', 'DM']
  if (!source || source.kind === 'stereo' || source.kind === 'mono') return mixes
  return [...ch.seatOrder('surround', source), ...mixes]
}

/**
 * ctx: { store, log, ffmpegPath() , ffprobePath(), resolveFile(kind, id) -> path | null, canView(userId, kind, id) -> { ok, title? },
 *        getUser(userId), getJoinOrigins(), isHomeRequest(req), getClientIp(req), profile() (encoderCapabilities.performanceProfile),
 *        qrSvg(text, opts), tmpRoot?, spawnFn?, now?, maxConcurrent? }
 */
function createPhoneSpeakersService(ctx) {
  const log = typeof ctx.log === 'function' ? ctx.log : () => {}
  const setting = (k, d) => { try { const v = ctx.store && ctx.store.get(k); return v === undefined || v === null || v === '' ? d : v } catch { return d } }
  const prober = tracksLib.createTrackProber({ ffprobePath: ctx.ffprobePath })
  const audio = audioLib.createAudioManager({
    ffmpegPath: ctx.ffmpegPath,
    // under the same temp folder as the video converter's pieces, in its own sub-folder (wiped when the app starts)
    tmpRoot: ctx.tmpRoot || path.join(os.tmpdir(), 'beebo-playback', 'phone-speakers'),
    profile: ctx.profile || null,
    maxConcurrent: ctx.maxConcurrent || null,
    log,
    ...(ctx.spawnFn ? { spawnFn: ctx.spawnFn } : {}),
    ...(ctx.now ? { now: ctx.now } : {})
  })
  const meta = new Map() // audioKey -> what is needed to open the session again if its cache was cleaned up

  function rateNow() { return QUALITY_RATE[setting('phoneSpeakersQuality', 'standard')] || ch.DEFAULT_RATE }

  async function prepare({ userId, kind, id }) {
    void userId
    let filePath = null
    try { filePath = await ctx.resolveFile(kind, id) } catch { filePath = null }
    if (!filePath) return { ok: false, status: 404, error: 'unavailable' }
    const tracks = await prober.probe(filePath)
    if (!tracks) return { ok: false, status: 422, error: 'no_audio', message: 'The computer could not read this film.' }
    const audios = tracks.audio || []
    const track = audios.find((a) => a.isDefault) || audios[0]
    if (!track) return { ok: false, status: 422, error: 'no_audio', message: 'This film has no sound to share.' }
    if (!(tracks.durationSec > 0)) return { ok: false, status: 422, error: 'no_audio', message: 'The length of this film is unknown.' }
    const source = ch.describeSource(track)
    if (!source.channels || !Number.isInteger(source.streamIndex)) return { ok: false, status: 422, error: 'no_audio', message: 'This film has no sound to share.' }
    let st = null
    try { st = fs.statSync(filePath) } catch { return { ok: false, status: 404, error: 'unavailable' } }
    const rate = rateNow()
    const key = crypto.createHash('sha1').update(`${filePath}|${st.size}|${st.mtimeMs}|${source.streamIndex}|${rate}|v1`).digest('hex').slice(0, 24)
    const info = { key, filePath, source, durationSec: tracks.durationSec, feeds: feedsFor(source), rate }
    try {
      audio.open(info)
    } catch (e) {
      if (e && e.code === 'busy') return { ok: false, status: 503, error: 'server_busy', message: e.message }
      return { ok: false, status: 422, error: 'no_audio', message: 'The computer could not prepare this film\'s sound.' }
    }
    meta.set(key, info)
    return { ok: true, source, durationSec: tracks.durationSec, audioKey: key, rate, title: '' }
  }

  const manager = roomsLib.createPhoneSpeakers({
    now: ctx.now,
    log,
    canView: ctx.canView,
    prepare,
    onRoomClosed: (room) => {
      // Nobody else uses this film's audio: the cache is kept for a while (rewinding, a second night) and cleaned by LRU.
      void room
    }
  })

  function getSession(key) {
    const s = audio.get(key)
    if (s) return s
    const m = meta.get(key)
    if (!m) return null
    try { return audio.open(m) } catch { return null }
  }

  const http = httpLib.createPhoneSpeakersHttp({
    manager, audio, getSession,
    getIp: ctx.getClientIp,
    isHomeRequest: ctx.isHomeRequest,
    isEnabled: () => setting('phoneSpeakersEnabled', true) !== false,
    allowRemote: () => setting('phoneSpeakersAllowRemote', false) === true,
    getJoinOrigins: ctx.getJoinOrigins,
    qrSvg: ctx.qrSvg,
    getUser: ctx.getUser,
    defaults: () => ({ fillIn: ['tv', 'neighbour', 'off'].includes(setting('phoneSpeakersFillIn', 'tv')) ? setting('phoneSpeakersFillIn', 'tv') : 'tv' }),
    log
  })

  /** Settings for the desktop app's panel. */
  function getSettings() {
    return {
      enabled: setting('phoneSpeakersEnabled', true) !== false,
      allowRemote: setting('phoneSpeakersAllowRemote', false) === true,
      quality: setting('phoneSpeakersQuality', 'standard') === 'high' ? 'high' : 'standard',
      fillIn: ['tv', 'neighbour', 'off'].includes(setting('phoneSpeakersFillIn', 'tv')) ? setting('phoneSpeakersFillIn', 'tv') : 'tv',
      rooms: manager.statusOf().rooms,
      load: audio.load(),
      limits: audio.limits()
    }
  }
  function setSettings(patch) {
    const p = patch && typeof patch === 'object' ? patch : {}
    try {
      if (typeof p.enabled === 'boolean') ctx.store.set('phoneSpeakersEnabled', p.enabled)
      if (typeof p.allowRemote === 'boolean') ctx.store.set('phoneSpeakersAllowRemote', p.allowRemote)
      if (p.quality === 'standard' || p.quality === 'high') ctx.store.set('phoneSpeakersQuality', p.quality)
      if (['tv', 'neighbour', 'off'].includes(p.fillIn)) ctx.store.set('phoneSpeakersFillIn', p.fillIn)
    } catch (e) { log(`[phone-speakers] could not save settings: ${e && e.message}`) }
    if (p.enabled === false) manager.closeAll('switched_off')
    return getSettings()
  }

  function close() {
    try { http.close() } catch {}
    try { audio.closeAll() } catch {}
  }

  return { ...http, http, manager, audio, getSettings, setSettings, prepare, close, feedsFor }
}

let active = null
/** The running server's service, for the desktop app's IPC (set by the stream server). */
const setActive = (s) => { active = s }
const getActive = () => active

module.exports = { createPhoneSpeakersService, feedsFor, lanCandidates, lanOrigins, QUALITY_RATE, setActive, getActive }
