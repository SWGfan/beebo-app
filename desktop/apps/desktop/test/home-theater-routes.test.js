// homeTheater.js with fake dependencies (no server, no ffmpeg): the info block, the negotiate answers and every fallback
// (index still being read, index failed, file that does not start on a key frame, remux off), and what goes into a
// direct-stream ticket.
// Run: node --test test/home-theater-routes.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const homeTheater = localRequire('./electron/homeTheater')
const tracksLib = localRequire('./electron/playbackTracks')
const F = require('./helpers/ffprobeFixtures')

const data = {}
const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
const clear = () => { for (const k of Object.keys(data)) delete data[k] }

function rig({ probe, ext = '.mkv', index = { state: 'ready', keyframes: [0, 3, 6, 9] }, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', startBody = { ok: true, url: '/hls/T/index.m3u8', ticket: 'T' } }) {
  const tracks = tracksLib.parseTracks(probe)
  const seen = { tickets: [], starts: [], indexCalls: 0 }
  const fakeIndex = { get: () => { seen.indexCalls++; return index }, wait: async () => { seen.indexCalls++; return index }, ensure: async () => index }
  const ht = homeTheater.createHomeTheater({
    store, tmpRoot: path.join(os.tmpdir(), 'beebo-ht-fake'), keyframeIndex: fakeIndex,
    fileAndTracks: async (kind, id) => (id === 'missing' ? { error: 'not_found' } : { filePath: `D:\\Movies\\film${ext}`, tracks }),
    sign: (id) => `sig-${id}`,
    hls: { makeTicket: (sign, fields) => { seen.tickets.push(fields); return 'TICKET' + seen.tickets.length } },
    startTranscode: async (body) => { seen.starts.push(body); return { status: 200, body: startBody } },
    getFfmpeg: () => ffmpeg, getFfprobe: () => ffprobe,
    audioEncoders: async () => ({ aac: true, ac3: true, eac3: true })
  })
  return { ht, seen, tracks }
}
const APPLE = { 'user-agent': 'AppleTV11,1/16.1' }

test('info block: badges, classification and the plan; nothing for the library sweeps; no key frame scan without a request', () => {
  clear()
  const { ht, seen } = rig({ probe: F.dv81() })
  const tracks = tracksLib.parseTracks(F.dv81())
  assert.equal(ht.infoBlock({ tracks, filePath: 'D:\\Movies\\f.mkv', userId: 'system:sweep' }), null, 'the subtitle sweep asks for tracks only')
  assert.equal(ht.infoBlock({ tracks: null, filePath: 'x', userId: 'u1' }), null)
  const noReq = ht.infoBlock({ tracks, filePath: 'D:\\Movies\\f.mkv', userId: 'u1' })
  assert.equal(seen.indexCalls, 0, 'no request headers: no scan')
  assert.deepEqual(noReq.badges, ['4K', 'Dolby Vision', 'HDR10', 'Atmos', '5.1'])
  assert.equal(noReq.video.dolbyVision.label, '8.1'); assert.equal(noReq.audio[0].spatialFormat, 'DolbyAtmos'); assert.equal(noReq.profile.client, 'generic')
  const b = ht.infoBlock({ tracks, filePath: 'D:\\Movies\\f.mkv', userId: 'u1', headers: APPLE })
  assert.equal(b.profile.client, 'appletv'); assert.equal(b.plan.method, 'DirectStream'); assert.equal(b.plan.video.tag, 'dvh1')
  assert.equal(seen.indexCalls, 1, 'a real client viewing the page warms the key frame index of a film that will be remuxed')
  assert.equal(b.remux.available, true); assert.equal(b.settings.directPlayPreferred, true)
})

test('negotiate: DirectPlay for a movie and for an episode, with the media token in the URL', async () => {
  clear()
  const mp4Probe = { ...F.sdr1080(), format: { ...F.sdr1080().format, format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }
  // an MP4 of H.264 + AAC plays as it is on a browser
  const g = rig({ probe: mp4Probe, ext: '.mp4' })
  const r = await g.ht.negotiate({ kind: 'movie', id: 'abc', client: 'chrome' }, { userId: 'u1', headers: {} })
  assert.equal(r.status, 200); assert.equal(r.body.method, 'DirectPlay'); assert.equal(r.body.url, '/file?id=abc&mt=sig-abc'); assert.equal(r.body.mimeType, 'video/mp4')
  // an episode goes to /tvfile, and the id and token are URL-encoded
  const tv = await g.ht.negotiate({ kind: 'tv', id: 'ep 1/x', client: 'chrome' }, { userId: 'u1' })
  assert.equal(tv.body.url, `/tvfile?id=${encodeURIComponent('ep 1/x')}&mt=${encodeURIComponent('sig-ep 1/x')}`)
  assert.equal((await g.ht.negotiate({ kind: 'movie' }, { userId: 'u1' })).status, 400)
  assert.equal((await g.ht.negotiate({ kind: 'movie', id: 'missing' }, { userId: 'u1' })).status, 404)
  assert.equal((await rig({ probe: { streams: [F.audio()], format: {} } }).ht.negotiate({ kind: 'movie', id: 'a' }, { userId: 'u1' })).status, 422)
})

test('negotiate: a direct-stream ticket carries the tag, strip, audio and range the session needs', async () => {
  clear()
  // Dolby Vision 8.1 + Atmos on Apple TV: everything kept
  let g = rig({ probe: F.dv81() })
  let r = await g.ht.negotiate({ kind: 'movie', id: 'f1' }, { userId: 'u1', headers: APPLE })
  assert.equal(r.status, 200); assert.equal(r.body.method, 'DirectStream'); assert.equal(r.body.url, '/hls/TICKET1/master.m3u8'); assert.equal(r.body.container, 'hls-fmp4')
  assert.deepEqual(g.seen.tickets[0], { k: 'movie', i: 'f1', u: 'u1', rx: { a: 1, ac: 'copy', t: 'dvh1', ad: 'eac3', ch: 6, hr: 'PQ', dv: 1 } })
  // Dolby Vision 7 + TrueHD on Apple TV: RPU stripped, audio converted (with the hlsAudio request in the ticket)
  g = rig({ probe: F.dv7fel() })
  r = await g.ht.negotiate({ kind: 'movie', id: 'f2' }, { userId: 'u1', headers: APPLE })
  const rx = g.seen.tickets[0].rx
  assert.equal(rx.t, 'hvc1'); assert.equal(rx.s, 1); assert.equal(rx.ac, 'encode'); assert.equal(rx.ad, 'eac3'); assert.equal(rx.ch, 6); assert.equal(rx.dv, undefined)
  assert.ok(rx.au && rx.au.s === 1 && rx.au.c === 'eac3', JSON.stringify(rx.au))
  // read back tolerantly
  assert.deepEqual(homeTheater.readRx({ a: 'x', ac: 'weird', t: 'evil', s: 5, au: 'no', ad: 'dts', ch: 99, hr: 'X', dv: 2 }), { a: null, ac: 'encode', t: 'avc1', s: 0, au: null, ad: '', ch: 16, hr: 'SDR', dv: 0 })
  assert.deepEqual(homeTheater.readRx(null).t, 'avc1')
})

test('negotiate: an index that is still being read answers "preparing"; a failed one, or a film that does not start on a key frame, is converted with a reason', async () => {
  clear()
  let g = rig({ probe: F.hdr10_4k(), index: { state: 'scanning' } })
  let r = await g.ht.negotiate({ kind: 'movie', id: 'f1', waitMs: 0 }, { userId: 'u1', headers: APPLE })
  assert.equal(r.status, 503); assert.equal(r.body.error, 'preparing'); assert.equal(r.body.retryAfterSec, 3); assert.equal(r.body.plan.method, 'DirectStream'); assert.equal(g.seen.starts.length, 0)
  g = rig({ probe: F.hdr10_4k(), index: { state: 'failed', error: 'probe_failed' } })
  r = await g.ht.negotiate({ kind: 'movie', id: 'f1' }, { userId: 'u1', headers: APPLE })
  assert.equal(r.status, 200); assert.equal(r.body.method, 'Transcode'); assert.ok(r.body.plan.reasonCodes.includes('REMUX_UNAVAILABLE')); assert.equal(g.seen.starts.length, 1)
  g = rig({ probe: F.hdr10_4k(), index: { state: 'ready', keyframes: [7.5, 10.5, 13.5] } })
  r = await g.ht.negotiate({ kind: 'movie', id: 'f1' }, { userId: 'u1', headers: APPLE })
  assert.equal(r.body.method, 'Transcode'); assert.ok(r.body.plan.reasonCodes.includes('REMUX_UNAVAILABLE'))
  // no ffmpeg on the computer: the plan never offers a remux
  g = rig({ probe: F.hdr10_4k(), ffmpeg: null })
  r = await g.ht.negotiate({ kind: 'movie', id: 'f1' }, { userId: 'u1', headers: APPLE })
  assert.equal(r.body.method, 'Transcode'); assert.ok(r.body.plan.reasonCodes.includes('DIRECT_STREAM_OFF'))
})

test('negotiate: a Transcode starts the live conversion with the quality, the audio track and the sound the plan chose', async () => {
  clear()
  data.homeTheater = { forceTranscode: true }
  // a device that plays E-AC-3 gets it COPIED through the conversion
  let g = rig({ probe: F.hdr10_4k() })
  let r = await g.ht.negotiate({ kind: 'movie', id: 'f1', audio: 1 }, { userId: 'u1', headers: APPLE })
  assert.equal(r.body.method, 'Transcode'); assert.equal(r.body.container, 'hls-ts')
  assert.deepEqual([g.seen.starts[0].kind, g.seen.starts[0].id, g.seen.starts[0].quality, g.seen.starts[0].audio], ['movie', 'f1', '1080p', 1])
  assert.equal(g.seen.starts[0].audioMode, 'passthrough'); assert.deepEqual(g.seen.starts[0].audioCaps, { maxChannels: 6, codecs: ['eac3'] })
  // a device that does not: converted to 5.1 AAC (surround) or stereo
  g = rig({ probe: F.hdr10_4k() })
  r = await g.ht.negotiate({ kind: 'movie', id: 'f1' }, { userId: 'u1', headers: { 'x-beebo-client': 'chrome' } })
  assert.equal(g.seen.starts[0].audioMode, 'surround'); assert.deepEqual(g.seen.starts[0].audioCaps.codecs, ['aac'])
  // a picture subtitle to burn
  g = rig({ probe: { ...F.hdr10_4k(), streams: [...F.hdr10_4k().streams, { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' }, disposition: {} }] } })
  r = await g.ht.negotiate({ kind: 'movie', id: 'f1', subtitle: { streamIndex: 3 } }, { userId: 'u1', headers: APPLE })
  assert.equal(g.seen.starts[0].burnSubtitle, 3); assert.equal(r.body.plan.subtitles.action, 'burn')
  // the answer of the live conversion passes through (a busy server keeps its line position)
  const busy = rig({ probe: F.hdr10_4k() })
  busy.ht = homeTheater.createHomeTheater({
    store, keyframeIndex: { get: () => ({ state: 'ready', keyframes: [0] }), wait: async () => ({ state: 'ready', keyframes: [0] }) },
    fileAndTracks: async () => ({ filePath: 'D:\\Movies\\f.mkv', tracks: tracksLib.parseTracks(F.hdr10_4k()) }), sign: (i) => i, hls: { makeTicket: () => 'T' },
    startTranscode: async () => ({ status: 503, body: { ok: false, error: 'busy', queued: true, position: 2 } }), getFfmpeg: () => 'f', getFfprobe: () => 'p', audioEncoders: async () => null
  })
  r = await busy.ht.negotiate({ kind: 'movie', id: 'f1' }, { userId: 'u1', headers: APPLE })
  assert.equal(r.status, 503); assert.equal(r.body.error, 'busy'); assert.equal(r.body.position, 2); assert.equal(r.body.plan.method, 'Transcode')
  clear()
})

test('profile: body declaration, header declaration (base64url), bare platform word, User-Agent', () => {
  clear()
  const { ht } = rig({ probe: F.sdr1080() })
  assert.equal(ht.profileFor({ body: { deviceProfile: { client: 'roku', hdr: ['hdr10', 'dv:8'] } } }).hdr.dv[0], '8')
  const enc = Buffer.from(JSON.stringify({ client: 'lg', hdr: ['hlg'] })).toString('base64url')
  assert.equal(ht.profileFor({ headers: { 'x-beebo-device-profile': enc } }).client, 'lg')
  assert.equal(ht.profileFor({ headers: { 'x-beebo-device-profile': 'samsung' } }).client, 'samsung')
  assert.equal(ht.profileFor({ body: { client: 'firetv' }, headers: { 'user-agent': 'Roku/1' } }).client, 'firetv')
  assert.equal(ht.profileFor({ headers: { 'user-agent': 'Roku/DVP' } }).client, 'roku')
  assert.equal(ht.profileFor({}).client, 'generic')
  assert.equal(ht.profileFor({ body: { deviceProfile: '{not json' }, headers: {} }).client, 'generic')
})
