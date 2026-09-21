// Client capability declarations (deviceProfile.js): platform detection from a client name or User-Agent,
// normalisation (nothing is trusted), the conservative platform defaults, and the merge of a partial
// declaration over a default.
// Run: node --test test/device-profile.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const dp = localRequire('./electron/deviceProfile')

test('platform is worked out from the client name first, then the User-Agent', () => {
  const t = [
    [{ client: 'androidtv' }, 'androidtv'], [{ client: 'Android-TV' }, 'androidtv'], [{ client: 'Fire TV' }, 'firetv'], [{ client: 'firetv' }, 'firetv'],
    [{ client: 'tvOS' }, 'appletv'], [{ client: 'tizen' }, 'samsung'], [{ client: 'webos' }, 'lg'], [{ client: 'roku' }, 'roku'], [{ client: 'xbox' }, 'xbox'],
    [{ userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36' }, 'samsung'],
    [{ userAgent: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager' }, 'lg'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One) AppleWebKit/537.36 Chrome/70.0 Safari/537.36 Edge/44.18363.8131' }, 'xbox'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7233) AppleWebKit/537.36 (KHTML, like Gecko) Silk/91.3.5 like Chrome/91.0 Safari/537.36' }, 'firetv'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A) AppleWebKit/537.36 Chrome/90 Safari/537.36' }, 'androidtv'],
    [{ userAgent: 'Roku/DVP-12.5 (12.5.0.4179-24)' }, 'roku'],
    [{ userAgent: 'AppleTV11,1/16.1' }, 'appletv'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }, 'ios'],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' }, 'android'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0' }, 'edge'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, 'chrome'],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0' }, 'firefox'],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' }, 'safari'],
    [{ userAgent: 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112 Safari/537.36 CrKey/1.56.500000' }, 'chromecast'],
    [{ userAgent: 'okhttp/4.12.0' }, 'generic'], [{}, 'generic'],
    // an explicit client name beats the User-Agent
    [{ client: 'appletv', userAgent: 'Mozilla/5.0 Chrome/120 Safari/537.36' }, 'appletv']
  ]
  for (const [input, want] of t) assert.equal(dp.detectPlatform(input), want, JSON.stringify(input).slice(0, 90))
})

test('every platform has a conservative default that is valid and never guesses receiver formats', () => {
  for (const id of dp.PLATFORMS) {
    const p = dp.defaultProfile(id)
    assert.equal(p.client, id); assert.equal(p.source, `default:${id}`)
    assert.ok(Object.keys(p.video).includes('h264'), `${id} plays H.264`)
    assert.ok(p.containers.length && p.streaming.length, `${id} names its containers and stream formats`)
    for (const k of ['truehd', 'dtshd', 'dtsx']) assert.equal(p.audio[k], undefined, `${id}: TrueHD / DTS-HD / DTS:X passthrough is never assumed`)
    assert.equal(p.audio.dts, undefined, `${id}: DTS is never assumed`)
    assert.equal(p.hdr.hdr10plus && id !== 'samsung', false, `${id}: HDR10+ is never assumed`)
  }
  // only Apple and LG are known to do Dolby Vision; Samsung is known not to
  for (const id of dp.PLATFORMS) assert.equal(dp.defaultProfile(id).hdr.dv.length > 0, ['appletv', 'ios', 'lg'].includes(id), id)
  assert.equal(dp.defaultProfile('samsung').hdr.hdr10plus, true)
  // browsers cannot know the screen: no HDR
  for (const id of ['chrome', 'edge', 'firefox', 'safari', 'generic']) { const h = dp.defaultProfile(id).hdr; assert.equal(h.hdr10 || h.hlg, false, id) }
  // tvOS does not open Matroska
  assert.equal(dp.defaultProfile('appletv').containers.includes('mkv'), false)
  assert.equal(dp.defaultProfile('androidtv').containers.includes('mkv'), true)
  // the generic client is the most conservative of all
  const g = dp.defaultProfile('generic')
  assert.deepEqual(g.containers, ['mp4']); assert.deepEqual(g.streaming, ['hls-ts']); assert.equal(g.maxHeight, 1080)
  assert.equal(dp.defaultProfile('nonsense').client, 'generic')
})

test('normalize: nothing is trusted (unknown keys dropped, numbers clamped, lists capped)', () => {
  const p = dp.normalize({
    v: 1, client: 'AndroidTV', name: '<script>alert(1)</script> Den',
    video: { hevc: { profiles: ['Main', 'Main 10', 'x'.repeat(500)], maxLevel: 999999, bitDepths: [8, 10, 99, 'abc'] }, madeup: { profiles: ['x'] }, h264: true },
    hdr: ['HDR10', 'hdr10+', 'HLG', 'dv:5, 8', 'dvfallback', 'bogus'],
    maxHeight: 99999, maxFps: -5, maxBitrateKbps: 'lots',
    audio: { eac3: { maxChannels: 99, passthrough: true, atmos: true }, truehd: {}, aac: 'yes', made: {} },
    containers: ['MKV', 'mp4', 'exe'], streaming: ['hls-fmp4', 'rtsp'], subtitles: 'vtt, srt, evil'
  })
  assert.equal(p.client, 'androidtv')
  assert.doesNotMatch(p.name, /[<>]/)
  assert.deepEqual(p.video.hevc.profiles.slice(0, 2), ['main', 'main10']); assert.equal(p.video.hevc.maxLevel, 999); assert.deepEqual(p.video.hevc.bitDepths, [8, 10, 16])
  assert.equal(p.video.madeup, undefined); assert.deepEqual(Object.keys(p.video).sort(), ['h264', 'hevc'])
  assert.deepEqual(p.hdr, { hdr10: true, hdr10plus: true, hlg: true, dv: ['5', '8'], dvFallback: true })
  assert.equal(p.maxHeight, 8640); assert.equal(p.maxFps, 0); assert.equal(p.maxBitrateKbps, 0)
  assert.equal(p.audio.eac3.maxChannels, 16); assert.equal(p.audio.eac3.atmos, true); assert.equal(p.audio.eac3.passthrough, true)
  // a TrueHD entry with no flags means "I pass it to the receiver", never "I decode it"
  assert.deepEqual([p.audio.truehd.passthrough, p.audio.truehd.decode], [true, false])
  assert.equal(p.audio.aac.decode, true); assert.equal(p.audio.made, undefined)
  assert.deepEqual(p.containers, ['mkv', 'mp4']); assert.deepEqual(p.streaming, ['hls-fmp4']); assert.deepEqual(p.subtitles, ['vtt', 'srt'])
  // garbage in -> a valid, empty profile
  for (const junk of [null, undefined, 5, 'x', [], { video: 5, audio: [], hdr: 7 }]) {
    const n = dp.normalize(junk)
    assert.deepEqual(n.video, {}); assert.deepEqual(n.audio, {}); assert.equal(n.hdr.hdr10, false); assert.deepEqual(n.stated, {})
  }
})

test('h264 "maxProfile" and profile names map to the keys the decision reads', () => {
  const p = dp.normalize({ video: { h264: { maxProfile: 'High', maxLevel: 52 } } })
  assert.deepEqual(p.video.h264.profiles, ['baseline', 'main', 'high'])
  assert.equal(dp.profileKey('hevc', 'Main 10'), 'main10'); assert.equal(dp.profileKey('hevc', 'Main'), 'main')
  assert.equal(dp.profileKey('hevc', 'Rext'), 'rext'); assert.equal(dp.profileKey('hevc', 'Main 4:4:4 12'), 'rext')
  assert.equal(dp.profileKey('h264', 'High 10'), 'high10'); assert.equal(dp.profileKey('h264', 'Constrained Baseline'), 'baseline')
  assert.equal(dp.profileKey('h264', 'High 4:4:4 Predictive'), 'high444')
  assert.equal(dp.profileKey('vp9', 'Profile 2'), 'profile2')
})

test('a declaration replaces only the parts it states; the rest is the platform default', () => {
  // states only HDR: everything else is the Android TV default
  const a = dp.resolveProfile({ declared: { hdr: ['hdr10', 'hdr10plus', 'dv:5,7,8'] }, client: 'androidtv' })
  assert.equal(a.source, 'declared+default:androidtv')
  assert.deepEqual(a.hdr.dv, ['5', '7', '8']); assert.equal(a.hdr.hdr10plus, true)
  assert.deepEqual(Object.keys(a.audio), Object.keys(dp.defaultProfile('androidtv').audio))
  assert.deepEqual(a.containers, dp.defaultProfile('androidtv').containers)
  // states audio: replaces the audio block whole (a receiver that lists no AC-3 has no AC-3)
  const b = dp.resolveProfile({ declared: { audio: { truehd: { atmos: true }, eac3: { passthrough: true, decode: true, atmos: true } }, maxAudioChannels: 8 }, userAgent: 'Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A) Chrome/90' })
  assert.deepEqual(Object.keys(b.audio).sort(), ['eac3', 'truehd']); assert.equal(b.maxAudioChannels, 8)
  assert.equal(b.client, 'androidtv')
  // an empty or unknown declaration is just the default for the User-Agent
  const c = dp.resolveProfile({ declared: {}, userAgent: 'Roku/DVP-12.5' })
  assert.equal(c.source, 'default:roku')
  assert.equal(dp.resolveProfile({ declared: null, userAgent: '' }).client, 'generic')
  // a fully stated profile is "declared"
  const full = dp.resolveProfile({ declared: dp.toDeclaration(dp.defaultProfile('lg')) })
  assert.equal(full.client, 'lg')
  // and round-trips
  const round = dp.normalize(dp.toDeclaration(dp.defaultProfile('samsung')))
  assert.deepEqual(round.hdr, dp.defaultProfile('samsung').hdr); assert.deepEqual(Object.keys(round.video), Object.keys(dp.defaultProfile('samsung').video))
})

test('a stated resolution box replaces the default box, the way a 4K client expects', () => {
  const p = dp.resolveProfile({ declared: { maxResolution: '3840x2160' }, client: 'generic' })
  assert.equal(p.maxHeight, 2160); assert.equal(p.maxWidth, 3840)
  const q = dp.resolveProfile({ declared: { maxHeight: 2160 }, client: 'generic' })
  assert.equal(q.maxHeight, 2160); assert.equal(q.maxWidth, 0)
})

test('declarations arrive as JSON, base64url JSON, or a compact header; junk is ignored', () => {
  const decl = { v: 1, client: 'appletv', hdr: ['hdr10', 'dv:8'] }
  const json = JSON.stringify(decl)
  assert.equal(dp.parseDeclaration(json).client, 'appletv')
  assert.equal(dp.parseDeclaration(Buffer.from(json).toString('base64url')).client, 'appletv')
  assert.equal(dp.parseDeclaration('not json'), null); assert.equal(dp.parseDeclaration('{bad'), null); assert.equal(dp.parseDeclaration('x'.repeat(20000)), null)
  const viaHeader = dp.resolveProfile({ declared: Buffer.from(json).toString('base64url') })
  assert.deepEqual(viaHeader.hdr.dv, ['8']); assert.equal(viaHeader.client, 'appletv')
  assert.match(dp.describeProfile(dp.defaultProfile('appletv')), /Dolby Vision 5\/8/)
})
