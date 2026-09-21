import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildDeviceProfile, clientNameFor, describeProfile, hdrList } from '../app/js/util/deviceProfile.js'
import { negotiateBody, normalizeNegotiate, prepareWaitSec, isPlayableRoute, describePlan, NEGOTIATE_PATH } from '../app/js/util/playback.js'
import { normalizePlaybackInfo } from '../app/js/util/models.js'
import { probeEnv, readDisplay, makeSupports } from '../app/js/platform/capabilities.js'
import { createClient } from '../app/js/api.js'
import { createStore } from '../app/js/store.js'

// Device profile (docs/HOME-THEATER.md): the honest declaration each web TV sends with POST /api/playback/negotiate.

// A fake engine: it says yes to a plain mime type that equals one of the given words, and to a codec-bearing type that
// contains one of them ("video/mp4" alone does not make every mp4 codec playable).
const engine = (...yes) => (mime) => yes.some((f) => (f.includes('/') ? mime === f : mime.includes('codecs=') && mime.includes(f)))
const UHD_TV_ENGINE = engine(
  'avc1.640028', 'avc1.640029', 'avc1.640033', 'avc1.640034', 'avc1.4d401f', 'avc1.42e01e',
  'hvc1.1.6.L120.90', 'hvc1.1.6.L153.90', 'hvc1.2.4.L153.B0', 'vp09.00.10.08', 'vp09.02.10.10', 'av01.0.05M.08', 'av01.0.05M.10',
  'mp4a.40.2', 'ac-3', 'ec-3', 'audio/flac', 'opus', 'audio/mpeg',
  'video/mp4', 'video/x-matroska', 'video/webm', 'video/mp2t', 'application/vnd.apple.mpegurl'
)
const HD_TV_ENGINE = engine('avc1.640028', 'avc1.640029', 'avc1.4d401f', 'avc1.42e01e', 'mp4a.40.2', 'ac-3', 'video/mp4', 'application/x-mpegURL')

test('client names are the ones the server knows', () => {
  assert.equal(clientNameFor('tizen'), 'samsung')
  assert.equal(clientNameFor('webos'), 'lg')
  assert.equal(clientNameFor('xbox'), 'xbox')
  assert.equal(clientNameFor('browser'), 'chrome')
  assert.equal(clientNameFor('anything'), 'chrome')
})

test('nothing to probe -> a bare { v, client }: the server keeps its own default for the platform', () => {
  assert.deepEqual(buildDeviceProfile({ platform: 'tizen' }), { v: 1, client: 'samsung' })
  assert.deepEqual(buildDeviceProfile(null), { v: 1, client: 'chrome' })
  assert.equal(buildDeviceProfile({ platform: 'webos', name: 'Bad <name>' }).name, 'Bad name')
})

test('Samsung UHD HDR TV: only what the engine and the display reported', () => {
  const p = buildDeviceProfile({
    platform: 'tizen', name: 'Beebo TV app', supports: UHD_TV_ENGINE, hlsNative: true, hlsJs: false,
    display: { uhd: true, hdr10: true, hdr10plus: null, hlg: null, dvProfiles: null, atmos: null }
  })
  assert.equal(p.client, 'samsung')
  assert.deepEqual(Object.keys(p.video).sort(), ['av1', 'h264', 'hevc', 'vp9'])
  assert.deepEqual(p.video.hevc.bitDepths, [8, 10])
  assert.equal(p.video.h264.maxLevel, 52)
  assert.deepEqual(p.hdr, ['hdr10'])
  assert.equal(p.maxHeight, 2160)
  assert.equal(p.maxWidth, 3840)
  assert.ok(p.containers.includes('mkv') && p.containers.includes('mp4'))
  // Fragmented-MP4 HLS cannot be asked of a native player: TS pieces only.
  assert.deepEqual(p.streaming, ['hls-ts'])
  assert.deepEqual(p.subtitles, ['vtt'])
  assert.equal(p.audio.eac3.atmos, undefined)
  assert.equal(p.maxAudioChannels, 6)
})

test('a TV never claims what the platform cannot tell: no HDR10+, no Dolby Vision, no DTS / TrueHD, no passthrough', () => {
  // an engine that says YES to everything, and a display that reports nothing
  const p = buildDeviceProfile({ platform: 'tizen', supports: () => true, hlsNative: true, display: { uhd: null, hdr10: null, hdr10plus: null, hlg: null, dvProfiles: null, atmos: null } })
  assert.deepEqual(p.hdr, [])
  assert.equal(p.maxHeight, 1080, 'unknown panel size = 1080')
  for (const k of ['truehd', 'dts', 'dtshd', 'dtsx']) assert.equal(p.audio[k], undefined, k)
  for (const a of Object.values(p.audio)) { assert.equal(a.passthrough, undefined); assert.equal(a.atmos, undefined) }
  assert.ok(!JSON.stringify(p).includes('dv:'))
  assert.ok(!JSON.stringify(p).includes('hdr10plus'))
})

test('a plain HD TV: no HEVC, no HDR, 1080p', () => {
  const p = buildDeviceProfile({ platform: 'webos', supports: HD_TV_ENGINE, hlsNative: true, display: { uhd: false, hdr10: false, dvProfiles: [] } })
  assert.deepEqual(Object.keys(p.video), ['h264'])
  assert.deepEqual(p.hdr, [])
  assert.equal(p.maxHeight, 1080)
  assert.equal(p.maxWidth, undefined)
  assert.deepEqual(p.audio.ac3, { maxChannels: 6 })
  assert.equal(p.audio.eac3, undefined)
  assert.deepEqual(p.containers, ['mp4'])
})

test('LG webOS reporting HDR10, Dolby Vision and Atmos', () => {
  const p = buildDeviceProfile({
    platform: 'webos', supports: UHD_TV_ENGINE, hlsNative: true,
    display: { uhd: true, hdr10: true, hlg: true, dvProfiles: [5, 8], atmos: true }
  })
  assert.deepEqual(p.hdr, ['hdr10', 'hlg', 'dv:5,8'])
  assert.deepEqual(p.audio.eac3, { maxChannels: 8, atmos: true })
  assert.equal(p.maxAudioChannels, 8)
})

test('Xbox playing HLS through hls.js may say fragmented-MP4 HLS; native HLS only claims TS', () => {
  const viaJs = buildDeviceProfile({ platform: 'xbox', supports: UHD_TV_ENGINE, hlsJs: true, hlsNative: false, display: { uhd: true, hdr10: true } })
  assert.deepEqual(viaJs.streaming, ['hls-ts', 'hls-fmp4'])
  assert.equal(viaJs.client, 'xbox')
  const native = buildDeviceProfile({ platform: 'xbox', supports: engine('avc1.640028', 'video/mp4'), hlsNative: true, hlsJs: false })
  assert.deepEqual(native.streaming, ['hls-ts'])
  const none = buildDeviceProfile({ platform: 'xbox', supports: engine('avc1.640028', 'video/mp4'), hlsNative: false, hlsJs: false })
  assert.equal(none.streaming, undefined)
})

test('an engine that throws is treated as "no"', () => {
  const p = buildDeviceProfile({ platform: 'tizen', supports: () => { throw new Error('boom') } })
  assert.equal(p.video, undefined)
  assert.equal(p.audio, undefined)
  assert.deepEqual(p.hdr, [])
})

test('hdrList and describeProfile', () => {
  assert.deepEqual(hdrList({ hdr10: true, hlg: true, dvProfiles: [8] }), ['hdr10', 'hlg', 'dv:8'])
  assert.deepEqual(hdrList(null), [])
  assert.equal(describeProfile(null), '')
  assert.match(describeProfile({ video: { hevc: {}, h264: {} }, hdr: ['hdr10'], audio: { eac3: {} }, maxHeight: 2160 }), /hevc h264 · hdr10 · eac3 · 2160p/)
})

// ---- the server really reads it the way we mean (skipped when the desktop tree is not next to this app) --------------

const here = path.dirname(fileURLToPath(import.meta.url))
const serverModule = path.resolve(here, '../../../desktop/apps/desktop/electron/deviceProfile.js')
const haveServer = fs.existsSync(serverModule)
const serverProfile = haveServer ? createRequire(import.meta.url)(serverModule) : null

test('the desktop server parses our declaration and overrides only what we stated', { skip: !haveServer }, () => {
  const p = buildDeviceProfile({
    platform: 'tizen', supports: UHD_TV_ENGINE, hlsNative: true,
    display: { uhd: true, hdr10: true }
  })
  const r = serverProfile.resolveProfile({ declared: p })
  assert.equal(r.client, 'samsung')
  assert.equal(r.hdr.hdr10, true)
  assert.equal(r.hdr.hdr10plus, false, 'Samsung default assumes HDR10+; we did not claim it, so it is off')
  assert.deepEqual(r.hdr.dv, [])
  assert.deepEqual(r.streaming, ['hls-ts'])
  assert.ok(r.containers.includes('mkv'))
  assert.equal(r.audio.truehd, undefined)
  assert.equal(r.audio.dtshd, undefined)
  assert.equal(r.maxHeight, 2160)
  assert.equal(r.source, 'declared')
  // a bare declaration is just the platform default
  const bare = serverProfile.resolveProfile({ declared: buildDeviceProfile({ platform: 'webos' }) })
  assert.equal(bare.client, 'lg')
  assert.match(bare.source, /default:lg|declared\+default:lg/)
})

test('an SDR-only declaration (unknown display) turns the platform default HDR off on the server', { skip: !haveServer }, () => {
  const p = buildDeviceProfile({ platform: 'webos', supports: UHD_TV_ENGINE, hlsNative: true, display: {} })
  const r = serverProfile.resolveProfile({ declared: p })
  assert.equal(r.hdr.hdr10, false)
  assert.deepEqual(r.hdr.dv, [])
  assert.equal(r.maxHeight, 1080)
})

// ---- the probe (fake windows) ------------------------------------------------------------------------------------------

function fakeWindow(extra) {
  const video = { canPlayType: (m) => (UHD_TV_ENGINE(m) ? 'maybe' : '') }
  return { document: { createElement: (t) => (t === 'video' ? video : {}) }, ...extra }
}

test('probeEnv reads Tizen product info and HDR support', async () => {
  const win = fakeWindow({ webapis: { productinfo: { isUdPanelSupported: () => true }, avinfo: { isHdrTvSupport: () => true } } })
  const env = await probeEnv(win, 'tizen', { name: 'TV' })
  assert.equal(env.display.uhd, true)
  assert.equal(env.display.hdr10, true)
  assert.equal(env.hlsJs, false)
  assert.equal(env.supports('audio/mp4; codecs="ec-3"'), true)
  assert.equal(env.supports('audio/mp4; codecs="dtsc"'), false)
})

test('probeEnv reads webOS.deviceInfo, and gives up (unknown) if it never answers', async () => {
  const win = fakeWindow({ webOS: { deviceInfo: (cb) => cb({ uhd: 'true', hdr10: true, dolbyVision: true, dolbyAtmos: false }) } })
  const d = await readDisplay(win, 'webos')
  assert.deepEqual(d, { uhd: true, hdr10: true, hdr10plus: null, hlg: true, dvProfiles: [5, 8], atmos: false })
  const never = await readDisplay({ webOS: { deviceInfo: () => {} } }, 'webos')
  assert.equal(never.hdr10, null)
  const missing = await readDisplay({}, 'webos')
  assert.equal(missing.uhd, null)
})

test('probeEnv on a Chromium web view: HDR from the media query, UHD from the physical screen, hls.js from the engine hook', async () => {
  const win = fakeWindow({ matchMedia: (q) => ({ matches: q === '(dynamic-range: high)' }), screen: { width: 1920, height: 1080 }, devicePixelRatio: 2 })
  const env = await probeEnv(win, 'xbox', { engine: () => 'hlsjs' })
  assert.equal(env.display.hdr10, true)
  assert.equal(env.display.uhd, true)
  assert.equal(env.hlsJs, true)
  assert.equal(env.hlsNative, false)
  const sdr = await readDisplay({ matchMedia: () => ({ matches: false }), screen: { width: 1920, height: 1080 }, devicePixelRatio: 1 }, 'xbox')
  assert.equal(sdr.hdr10, false)
  assert.equal(sdr.uhd, false)
})

test('makeSupports uses canPlayType, then MediaSource for codec types only', () => {
  const video = { canPlayType: (m) => (m === 'video/mp4' ? 'probably' : '') }
  const win = { MediaSource: { isTypeSupported: (m) => m.includes('hvc1') } }
  const s = makeSupports(win, video)
  assert.equal(s('video/mp4'), true)
  assert.equal(s('video/mp4; codecs="hvc1.2.4.L153.B0"'), true)
  assert.equal(s('video/x-matroska'), false)
  assert.equal(makeSupports({}, null)('video/mp4'), false)
})

// ---- negotiate: body, answer, client -------------------------------------------------------------------------------------

test('negotiateBody carries the profile in the body (a TV app cannot send extra headers cross-origin)', () => {
  const profile = { v: 1, client: 'samsung' }
  const b = negotiateBody({ kind: 'tv', id: 'ep1', client: 'samsung', profile, audio: 2 })
  assert.deepEqual(b, { kind: 'tv', id: 'ep1', client: 'samsung', deviceProfile: profile, quality: 'original', audio: 2 })
  assert.equal(negotiateBody({ kind: 'weird', id: 'm', quality: '720p' }).kind, 'movie')
  assert.equal(negotiateBody({ kind: 'movie', id: 'm', quality: '720p' }).quality, '720p')
  assert.equal(negotiateBody({ kind: 'movie', id: 'm' }).deviceProfile, undefined)
})

const PLAN = { reasonCodes: ['CONTAINER_NOT_SUPPORTED'], playsAs: '4K HDR10 (copied)' }

test('normalizeNegotiate accepts exactly the three plans and their own routes', () => {
  const dp = normalizeNegotiate({ ok: true, method: 'DirectPlay', url: '/file?id=abc&mt=TOK', mimeType: 'video/x-matroska', durationSec: 6300, plan: PLAN })
  assert.equal(dp.method, 'DirectPlay')
  assert.equal(dp.url, '/file?id=abc&mt=TOK')
  assert.equal(dp.durationSec, 6300)
  assert.deepEqual(dp.reasons, ['CONTAINER_NOT_SUPPORTED'])
  assert.equal(normalizeNegotiate({ ok: true, method: 'DirectPlay', url: '/tvfile?id=e&mt=T' }).method, 'DirectPlay')
  const ds = normalizeNegotiate({ ok: true, method: 'DirectStream', url: '/hls/T1.abc-9/master.m3u8', ticket: 'T1.abc-9', container: 'hls-fmp4' })
  assert.equal(ds.method, 'DirectStream')
  assert.equal(ds.ticket, 'T1.abc-9')
  const tc = normalizeNegotiate({ ok: true, method: 'Transcode', url: '/hls/T2/index.m3u8', ticket: 'T2' })
  assert.equal(tc.method, 'Transcode')
  assert.equal(describePlan(dp), 'Direct play')
  assert.equal(describePlan(ds), 'Direct stream')
  assert.equal(describePlan(tc), 'Converted')
  assert.equal(describePlan(null), '')
})

test('normalizeNegotiate refuses a hostile or unknown answer (the caller falls back to /playback/start)', () => {
  const bad = [
    null, 5, 'x', {}, { ok: false, method: 'DirectPlay', url: '/file?id=a' },
    { ok: true, method: 'Teleport', url: '/file?id=a' },
    { ok: true, method: 'DirectPlay', url: 'http://evil.example/file?id=a' },
    { ok: true, method: 'DirectPlay', url: '//evil.example/file?id=a' },
    { ok: true, method: 'DirectPlay', url: '/api/admin/settings' },
    { ok: true, method: 'DirectPlay', url: '/hls/T/index.m3u8' },
    { ok: true, method: 'DirectStream', url: '/file?id=a&mt=T' },
    { ok: true, method: 'DirectStream', url: '/hls/T/../../login' },
    { ok: true, method: 'DirectStream', url: '/hls/T/evil.php' },
    { ok: true, method: 'Transcode', url: '/x.m3u8' },
    { ok: true, method: 'Transcode' }
  ]
  for (const b of bad) assert.equal(normalizeNegotiate(b), null, JSON.stringify(b))
  assert.equal(isPlayableRoute('DirectPlay', '/file?id=1'), true)
  assert.equal(isPlayableRoute('DirectStream', '/hls/a/master.m3u8'), true)
  assert.equal(isPlayableRoute('DirectStream', '/hls/a/master.m3u8\n'), false)
})

test('prepareWaitSec: only a 503 "preparing" is worth asking again', () => {
  assert.equal(prepareWaitSec({ status: 503, body: { error: 'preparing', retryAfterSec: 3 } }), 3)
  assert.equal(prepareWaitSec({ status: 503, body: { error: 'preparing', retryAfterSec: 99 } }), 10)
  assert.equal(prepareWaitSec({ status: 503, body: { error: 'preparing' } }), 3)
  assert.equal(prepareWaitSec({ status: 503, body: { error: 'other' } }), 0)
  assert.equal(prepareWaitSec({ status: 404, body: { error: 'preparing' } }), 0)
  assert.equal(prepareWaitSec(null), 0)
})

test('normalizePlaybackInfo: the homeTheater block is the feature test for the negotiate route', () => {
  assert.equal(normalizePlaybackInfo({ durationSec: 10 }).homeTheater, false)
  const i = normalizePlaybackInfo({ durationSec: 10, homeTheater: { badges: ['4K', 'Dolby Vision', '<b>x</b>', '', 'Atmos'], plan: {} } })
  assert.equal(i.homeTheater, true)
  assert.deepEqual(i.badges, ['4K', 'Dolby Vision', '<b>x</b>', 'Atmos']) // inert text: views use textContent
  assert.deepEqual(normalizePlaybackInfo({ homeTheater: 'yes' }).badges, [])
})

function fakeXHR(handler) {
  const seen = []
  class X {
    constructor() { this.headers = {}; this.status = 0; this.responseText = '' }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(k, v) { this.headers[k] = v }
    send(body) {
      seen.push(this)
      this.body = body
      const r = handler(this)
      setTimeout(() => { this.status = r.status; this.responseText = JSON.stringify(r.body); this.onload() }, 0)
    }
  }
  X.seen = seen
  return X
}

test('client.playbackNegotiate posts the declared profile with the bearer token, and parses the plan', async () => {
  const profile = { v: 1, client: 'samsung', hdr: [] }
  const XHR = fakeXHR(() => ({ status: 200, body: { ok: true, method: 'DirectPlay', url: '/file?id=m1&mt=T', plan: PLAN } }))
  const client = createClient({ XHR, getOrigin: () => 'http://h:47811', getToken: () => 'TOK', getProfile: () => profile, clientName: 'samsung' })
  const plan = await client.playbackNegotiate('movie', 'm1', { quality: 'original', audio: 3 })
  assert.equal(plan.method, 'DirectPlay')
  const x = XHR.seen[0]
  assert.equal(x.method, 'POST')
  assert.equal(x.url, 'http://h:47811' + NEGOTIATE_PATH)
  assert.equal(x.headers.Authorization, 'Bearer TOK')
  assert.equal(x.headers['X-Beebo-Device-Profile'], undefined, 'the profile is in the body, not in a header')
  assert.equal(x.headers['X-Beebo-Client'], undefined)
  assert.deepEqual(JSON.parse(x.body), { kind: 'movie', id: 'm1', client: 'samsung', deviceProfile: profile, quality: 'original', audio: 3 })
  assert.ok(!x.url.includes('TOK'))
})

test('client.playbackNegotiate: an unusable answer is bad_response, "preparing" keeps its body', async () => {
  const bad = createClient({ XHR: fakeXHR(() => ({ status: 200, body: { ok: true, method: 'DirectPlay', url: 'http://evil/x' } })), getOrigin: () => 'http://h', getToken: () => 't' })
  await assert.rejects(bad.playbackNegotiate('movie', 'a'), (e) => e.kind === 'bad_response')
  const prep = createClient({ XHR: fakeXHR(() => ({ status: 503, body: { ok: false, error: 'preparing', retryAfterSec: 3 } })), getOrigin: () => 'http://h', getToken: () => 't' })
  await assert.rejects(prep.playbackNegotiate('movie', 'a'), (e) => prepareWaitSec(e) === 3)
})

test('store: "play original" defaults on and can be switched off', () => {
  const mem = new Map()
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }
  const s = createStore(storage)
  assert.equal(s.getPlayOriginal(), true)
  s.setPlayOriginal(false)
  assert.equal(s.getPlayOriginal(), false)
  s.setPlayOriginal(true)
  assert.equal(s.getPlayOriginal(), true)
})
