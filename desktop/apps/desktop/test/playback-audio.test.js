// Sound of a live conversion (hlsAudio.js + hlsTranscoder.js): request validation, the ffmpeg audio
// options for many source layouts and codecs, ticket/cache-key separation, honest labels, and (when
// ffmpeg is on this machine) real measurements of the mix-down: no clipping, right channel content,
// no timing shift.
// Run: node --test test/playback-audio.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const hls = localRequire('./electron/hlsTranscoder')
const ha = localRequire('./electron/hlsAudio')

function findTool(name) {
  try {
    const convert = localRequire('./electron/convert')
    const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
    if (fromApp) return fromApp
  } catch {}
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')
const SKIP = FFMPEG && FFPROBE ? false : 'ffmpeg/ffprobe not found'

const argAfter = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const track = (codec, channels, channelLayout, extra = {}) => ({ ordinal: 0, streamIndex: 1, codec, channels, channelLayout, language: 'eng', isDefault: true, ...extra })
const tracksWith = (a) => ({ durationSec: 61, video: { streamIndex: 0, codec: 'h264', width: 1920, height: 1080, fps: 24, hdr: false }, audio: [a], subtitles: [] })
const build = (audioTrack, audio = null, extra = {}) => hls.buildTranscodeArgs({ input: 'in.mkv', tracks: tracksWith(audioTrack), quality: '720p', encoder: 'libx264', outDir: 'o', audio, audioEncoders: { aac: true, ac3: true, eac3: true }, ...extra })
const audioArgs = (args) => args.slice(args.indexOf('-g') + 4, args.indexOf('-f'))
const plan = (t, au, q = '720p', encoders = { aac: true, ac3: true, eac3: true }) => ha.planAudio({ track: t, au, quality: hls.QUALITIES[q], qualityId: q, encoders })

// ------------------------------------------------------- request validation
test('audio request: garbage becomes the safe default, good values pass', () => {
  const d = ha.normalizeAudioRequest(undefined)
  assert.deepEqual(d, { mode: 'auto', downmix: 'standard', night: false, normalize: false, delayMs: 0, caps: { maxChannels: 0, codecs: [] } })
  for (const junk of [null, 5, 'x', [], () => 1, { audioMode: 'DROP TABLE' }, { audioMode: {} }, { audioMode: ['surround'] }]) {
    assert.equal(ha.normalizeAudioRequest(junk).mode, 'auto')
  }
  const r = ha.normalizeAudioRequest({ audioMode: ' Surround ', downmix: 'DIALOGUE', night: 'on', normalize: 1, audioDelayMs: '-120.4', audioCaps: { maxChannels: 6, codecs: ['AAC', 'eac3', 'dts', 'rm -rf'] } })
  assert.deepEqual(r, { mode: 'surround', downmix: 'dialogue', night: true, normalize: true, delayMs: -120, caps: { maxChannels: 6, codecs: ['aac', 'eac3'] } })
  assert.equal(ha.normalizeAudioRequest({ downmix: 'loud' }).downmix, 'standard')
  assert.equal(ha.normalizeAudioRequest({ night: 'maybe' }).night, false)
  assert.equal(ha.normalizeAudioRequest({ night: 0 }).night, false)
})

test('audio request: delay is clamped to +-500 ms and junk is zero', () => {
  const d = (v) => ha.normalizeAudioRequest({ audioDelayMs: v }).delayMs
  assert.equal(d(9999), 500)
  assert.equal(d(-9999), -500)
  assert.equal(d(250.6), 251)
  for (const junk of ['abc', NaN, Infinity, null, undefined, {}, [], true, '']) assert.equal(d(junk), 0)
})

test('audio caps: object and "6:aac,ac3" string forms, bounded', () => {
  assert.deepEqual(ha.parseCaps('6:aac,ac3,eac3'), { maxChannels: 6, codecs: ['aac', 'ac3', 'eac3'] })
  assert.deepEqual(ha.parseCaps({ maxChannels: 99, codecs: 'aac' }), { maxChannels: 8, codecs: ['aac'] })
  assert.deepEqual(ha.parseCaps({ maxChannels: -3, codecs: [1, 2] }), { maxChannels: 0, codecs: [] })
  assert.deepEqual(ha.parseCaps('nope'), { maxChannels: 0, codecs: [] })
  assert.deepEqual(ha.parseCaps(42), { maxChannels: 0, codecs: [] })
  assert.deepEqual(ha.parseCaps(null), { maxChannels: 0, codecs: [] })
})

test('ticket audio: nothing that differs from the default means no au at all (old tickets stay identical)', () => {
  assert.equal(ha.ticketAudio(ha.normalizeAudioRequest({})), null)
  assert.equal(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'stereo' })), null)
  assert.equal(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'auto', audioCaps: { maxChannels: 2 } })), null, 'a stereo-only client is asked nothing special')
  assert.equal(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'nonsense', night: 'false' })), null)
})

test('ticket audio: auto picks surround only when the client says it can', () => {
  assert.equal(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'auto' })), null, 'no caps -> stereo like before')
  assert.equal(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'auto', audioCaps: { maxChannels: 2, codecs: [] } })), null)
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'auto', audioCaps: { maxChannels: 6, codecs: [] } })), { s: 1 })
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'auto', audioCaps: { maxChannels: 6, codecs: ['aac', 'ac3', 'eac3'] } })), { s: 1, c: 'eac3', k: 'aac,ac3,eac3', x: 6 })
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'auto', audioCaps: { maxChannels: 8, codecs: ['aac', 'ac3'] } })), { s: 1, c: 'ac3', k: 'aac,ac3', x: 6 })
  // Stereo-only client that can play Dolby Digital may get an untouched stereo track, never a 5.1 copy.
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'auto', audioCaps: { maxChannels: 2, codecs: ['aac', 'ac3'] } })), { k: 'aac,ac3', x: 2 })
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'stereo', audioCaps: { maxChannels: 6, codecs: ['aac'] } })), null, 'explicit stereo wins over caps')
})

test('ticket audio: explicit surround and passthrough, downmix, night, normalize, delay', () => {
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'surround' })), { s: 1 })
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ audioMode: 'passthrough' })), { s: 1, k: 'aac,ac3,eac3', x: 6 })
  assert.deepEqual(ha.ticketAudio(ha.normalizeAudioRequest({ downmix: 'dialogue', night: true, normalize: true, audioDelayMs: -80 })), { m: 'dialogue', n: 1, l: 1, d: -80 })
})

test('readTicketAudio: forged or old values fall back to defaults', () => {
  const d = ha.readTicketAudio(null)
  assert.deepEqual(d, { surround: false, codec: 'aac', copyCodecs: [], maxChannels: 0, downmix: 'standard', night: false, normalize: false, delayMs: 0 })
  const f = ha.readTicketAudio({ s: 'yes', c: 'dts', k: 'dts,truehd,ac3', x: 99, m: 'evil', n: 'true', l: 2, d: 99999 })
  assert.deepEqual(f, { surround: false, codec: 'aac', copyCodecs: ['ac3'], maxChannels: 6, downmix: 'standard', night: false, normalize: false, delayMs: 500 })
  assert.deepEqual(ha.readTicketAudio('junk'), d)
})

// --------------------------------------------------------------- cache keys
function ticketFor(fields) {
  const secret = 'k'
  const sign = (id) => { const exp = Date.now() + 1000; return `${exp}.${crypto.createHmac('sha256', secret).update(`${id}|${exp}`).digest('base64url')}` }
  const verify = (id, tok) => {
    const [exp, sig] = String(tok).split('.')
    return !!sig && Date.now() <= Number(exp) && sig === crypto.createHmac('sha256', secret).update(`${id}|${exp}`).digest('base64url')
  }
  return hls.readTicket(verify, hls.makeTicket(sign, fields))
}

test('cache keys: every audio choice is its own session; an old ticket keeps its key', () => {
  const base = { k: 'movie', i: 'abc', q: '720p', a: null, s: null, u: 'u1' }
  const legacy = ticketFor(base).sessionKey
  assert.equal(ticketFor({ ...base }).sessionKey, legacy, 'deterministic')
  const seen = new Set([legacy])
  const variants = [{ s: 1 }, { s: 1, c: 'eac3' }, { s: 1, c: 'ac3' }, { m: 'dialogue' }, { n: 1 }, { l: 1 }, { d: 100 }, { d: -100 }, { s: 1, k: 'aac', x: 6 }, { n: 1, m: 'dialogue' }]
  for (const au of variants) {
    const key = ticketFor({ ...base, au }).sessionKey
    assert.ok(!seen.has(key), `distinct key for ${JSON.stringify(au)}`)
    seen.add(key)
    assert.match(key, /^[0-9a-f]{20}$/)
  }
  // The ticket's audio object survives the round trip.
  assert.deepEqual(ticketFor({ ...base, au: { s: 1, c: 'eac3' } }).fields.au, { s: 1, c: 'eac3' })
})

// ---------------------------------------------------------------- channel roles
test('channel roles: named layouts, unknown layouts by count, nonsense rejected', () => {
  assert.deepEqual(ha.channelRoles('5.1', 6), ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'])
  assert.deepEqual(ha.channelRoles('5.1(side)', 6), ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'])
  assert.deepEqual(ha.channelRoles('7.1', 8), ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'])
  assert.deepEqual(ha.channelRoles('7.1(wide)', 8), ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC'])
  assert.deepEqual(ha.channelRoles('', 6), ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'], 'ffmpeg assumes 5.1(side) for six unlabelled channels')
  assert.deepEqual(ha.channelRoles(null, 2), ['FL', 'FR'])
  assert.deepEqual(ha.channelRoles('FL+FR+FC+LFE+SL+SR', 6), ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'], 'explicit decomposition')
  assert.deepEqual(ha.channelRoles('5.1', 8), ha.channelRoles('7.1', 8), 'a layout that disagrees with the count is ignored')
  assert.equal(ha.channelRoles('weird', 12), null)
  assert.equal(ha.channelRoles('5.1', 0), null)
  assert.equal(ha.channelRoles('5.1', 'x'), null)
  assert.equal(ha.channelRoles('FL+XX+FC', 3), ha.channelRoles('', 3) && ha.channelRoles('FL+XX+FC', 3), 'unknown role names fall back to the count default')
})

test('layout words are plain and honest', () => {
  assert.equal(ha.layoutWords(1, 'mono'), 'Mono')
  assert.equal(ha.layoutWords(2, 'stereo'), 'Stereo')
  assert.equal(ha.layoutWords(6, '5.1(side)'), '5.1')
  assert.equal(ha.layoutWords(8, '7.1'), '7.1')
  assert.equal(ha.layoutWords(7, '6.1'), '6.1')
  assert.equal(ha.layoutWords(6, ''), '5.1')
  assert.equal(ha.layoutWords(10, '5.1.4'), '5.1.4')
  assert.equal(ha.layoutWords(0, ''), '')
  assert.equal(ha.layoutWords(12, 'nonsense'), '12 channels')
})

// ------------------------------------------------------ downmix / surround maths
test('downmix: standard 5.1 -> stereo uses ITU-shaped gains, LFE folded in low', () => {
  const f = ha.stereoDownmixFilter(ha.channelRoles('5.1', 6), 'standard')
  assert.equal(f, 'pan=stereo|c0=1*c0+0.707*c2+0.3*c3+0.707*c4|c1=1*c1+0.707*c2+0.3*c3+0.707*c5')
})

test('downmix: dialogue mode lifts the centre ~3 dB and lowers fronts, surrounds and bass', () => {
  const std = ha.DOWNMIX_GAINS.standard
  const dia = ha.DOWNMIX_GAINS.dialogue
  const db = (x) => 20 * Math.log10(x)
  assert.ok(Math.abs(db(dia.center / std.center) - 3) < 0.5, 'centre about +3 dB')
  assert.ok(dia.front < std.front && dia.side < std.side && dia.lfe < std.lfe)
  assert.ok(db(dia.center / dia.side) - db(std.center / std.side) >= 5, 'speech stands further out of the surrounds')
  assert.equal(ha.stereoDownmixFilter(ha.channelRoles('5.1', 6), 'dialogue'), 'pan=stereo|c0=0.85*c0+1*c2+0.2*c3+0.5*c4|c1=0.85*c1+1*c2+0.2*c3+0.5*c5')
})

test('downmix: every listed layout produces a two-sided pan and no term references a missing channel', () => {
  for (const [layout, n] of [['3.0', 3], ['2.1', 3], ['quad', 4], ['4.0', 4], ['5.0', 5], ['5.1', 6], ['5.1(side)', 6], ['6.1', 7], ['7.0', 7], ['7.1', 8], ['7.1(wide)', 8], ['5.1.2', 8], ['7.1.4', 12]]) {
    for (const kind of ['standard', 'dialogue']) {
      const roles = ha.channelRoles(layout, n)
      assert.equal(roles.length, n, layout)
      const f = ha.stereoDownmixFilter(roles, kind)
      assert.match(f, /^pan=stereo\|c0=[^|]+\|c1=[^|]+$/, `${layout} ${kind}`)
      const used = [...f.matchAll(/c(\d+)(?![\d.])/g)].map((m) => Number(m[1])).filter((x) => x >= 0)
      for (const idx of used) assert.ok(idx < n, `${layout}: c${idx} exists`)
    }
  }
  assert.equal(ha.stereoDownmixFilter(['FL', 'FR']), null)
  assert.equal(ha.stereoDownmixFilter(null), null)
})

test('surround: 5.1 needs no pan; 7.1, 6.1 and 5.0 fold to 5.1', () => {
  assert.equal(ha.surround51Filter(ha.channelRoles('5.1', 6)), null)
  assert.equal(ha.surround51Filter(ha.channelRoles('5.1(side)', 6)), null)
  assert.equal(ha.surround51Filter(ha.channelRoles('7.1', 8)), 'pan=5.1|c0=1*c0|c1=1*c1|c2=1*c2|c3=1*c3|c4=0.707*c4+0.707*c6|c5=0.707*c5+0.707*c7')
  assert.equal(ha.surround51Filter(ha.channelRoles('6.1', 7)), 'pan=5.1|c0=1*c0|c1=1*c1|c2=1*c2|c3=1*c3|c4=0.707*c4+1*c5|c5=0.707*c4+1*c6')
  assert.equal(ha.surround51Filter(ha.channelRoles('5.0', 5)), 'pan=5.1|c0=1*c0|c1=1*c1|c2=1*c2|c3=0*c0|c4=1*c3|c5=1*c4', 'silent LFE')
  assert.equal(ha.surround51Filter(ha.channelRoles('7.1(wide)', 8)), 'pan=5.1|c0=1*c0+0.707*c6|c1=1*c1+0.707*c7|c2=1*c2|c3=1*c3|c4=1*c4|c5=1*c5')
  assert.equal(ha.surround51Filter(ha.channelRoles('stereo', 2)), null)
  assert.equal(ha.surround51Filter(null), null)
})

// ---------------------------------------------------------------- plans
test('plan: no audio stream', () => {
  const p = plan(null, null)
  assert.equal(p.kind, 'none')
  assert.deepEqual(p.args, ['-an'])
  assert.equal(ha.describeAudio(p).label, 'No sound')
})

test('plan: the default (no audio object) keeps stereo AAC exactly as it always was for stereo and mono sources', () => {
  for (const t of [track('aac', 2, 'stereo'), track('ac3', 2, 'stereo'), track('mp3', 2, ''), track('opus', 2, 'stereo'), track('aac', 1, 'mono'), track('aac', 0, null)]) {
    for (const [q, kbps] of [['1080p', 192], ['720p', 160], ['480p', 128]]) {
      const p = plan(t, null, q)
      assert.deepEqual(p.args, ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', `${kbps}k`], `${t.codec}/${t.channels}/${q}`)
      assert.deepEqual(p.filters, [])
    }
  }
})

test('plan: default for 5.1/7.1 sources is a real mix-down, not a blunt -ac 2', () => {
  for (const [codec, layout, n] of [['eac3', '5.1(side)', 6], ['ac3', '5.1', 6], ['dts', '5.1', 6], ['truehd', '7.1', 8], ['aac', '5.1', 6], ['opus', '5.1', 6], ['dts', '7.1', 8], ['flac', '5.1(side)', 6]]) {
    const p = plan(track(codec, n, layout), null)
    assert.equal(p.kind, 'encode')
    assert.equal(p.mixedDown, true)
    assert.equal(p.channels, 2)
    const af = argAfter(p.args, '-af')
    assert.ok(af.startsWith('aresample=48000:async=1:first_pts=0,pan=stereo|'), `${codec}: ${af}`)
    assert.ok(af.endsWith(ha.LIMITER_FILTER), 'a limiter guards the sum')
    assert.equal(argAfter(p.args, '-c:a'), 'aac')
    assert.equal(argAfter(p.args, '-ac'), '2')
    assert.equal(argAfter(p.args, '-ar'), '48000')
    assert.equal(argAfter(p.args, '-b:a'), '160k')
  }
})

test('plan: unknown layouts fold with aformat then the limiter (never a wrong pan)', () => {
  const p = plan(track('dts', 12, 'weird'), null)
  assert.equal(argAfter(p.args, '-af'), `aresample=48000:async=1:first_pts=0,aformat=channel_layouts=stereo,${ha.LIMITER_FILTER}`)
  assert.equal(p.mixedDown, true)
  const noLayout = plan(track('aac', 6, null), null)
  assert.match(argAfter(noLayout.args, '-af'), /pan=stereo/, 'six unlabelled channels are treated as 5.1')
})

test('plan: dialogue downmix changes only the pan', () => {
  const t = track('eac3', 6, '5.1(side)')
  const a = argAfter(plan(t, null).args, '-af')
  const b = argAfter(plan(t, { m: 'dialogue' }).args, '-af')
  assert.notEqual(a, b)
  assert.equal(a.replace(/pan=[^,]+/, ''), b.replace(/pan=[^,]+/, ''))
  assert.equal(plan(t, { m: 'dialogue' }).downmix, 'dialogue')
})

test('plan: surround 5.1 - codec follows the client, encoders that are missing fall back', () => {
  const t = track('dts', 6, '5.1')
  const aac = plan(t, { s: 1 })
  assert.deepEqual(aac.args, ['-c:a', 'aac', '-ar', '48000', '-b:a', '384k'].slice(0, 0).concat(['-af', 'aresample=48000:async=1:first_pts=0', '-c:a', 'aac', '-ar', '48000', '-b:a', '384k']))
  assert.equal(aac.channels, 6)
  assert.equal(aac.surround, true)
  assert.equal(aac.mixedDown, false)
  assert.ok(!aac.args.includes('-ac'), 'no channel count is forced on a surround output')
  const eac3 = plan(t, { s: 1, c: 'eac3' })
  assert.equal(argAfter(eac3.args, '-c:a'), 'eac3')
  assert.equal(argAfter(eac3.args, '-b:a'), '448k')
  assert.equal(argAfter(plan(t, { s: 1, c: 'eac3' }, '1080p').args, '-b:a'), '640k')
  assert.equal(argAfter(plan(t, { s: 1, c: 'eac3' }, '480p').args, '-b:a'), '384k')
  assert.equal(argAfter(plan(t, { s: 1, c: 'ac3' }, '1080p').args, '-b:a'), '448k')
  assert.equal(argAfter(plan(t, { s: 1 }, '1080p').args, '-b:a'), '448k')
  assert.equal(argAfter(plan(t, { s: 1 }, '480p').args, '-b:a'), '320k')
  // eac3 wanted but this ffmpeg has only ac3, or only aac.
  assert.equal(argAfter(plan(t, { s: 1, c: 'eac3' }, '720p', { aac: true, ac3: true, eac3: false }).args, '-c:a'), 'ac3')
  assert.equal(argAfter(plan(t, { s: 1, c: 'eac3' }, '720p', { aac: true, ac3: false, eac3: false }).args, '-c:a'), 'aac')
  assert.equal(argAfter(plan(t, { s: 1, c: 'ac3' }, '720p', { aac: true, ac3: false, eac3: true }).args, '-c:a'), 'aac', 'never upgrades past what was asked for')
  assert.equal(argAfter(plan(t, { s: 1, c: 'eac3' }, '720p', null).args, '-c:a'), 'aac', 'unknown encoder list means AAC only')
})

test('plan: surround only widens tracks that are actually surround', () => {
  for (const [codec, n, layout] of [['aac', 1, 'mono'], ['ac3', 2, 'stereo'], ['eac3', 3, '3.0'], ['dts', 4, 'quad']]) {
    const p = plan(track(codec, n, layout), { s: 1 })
    assert.equal(p.surround, false, `${n} channels stay as they are`)
    assert.equal(argAfter(p.args, '-ac'), '2')
  }
  const five = plan(track('ac3', 5, '5.0'), { s: 1 })
  assert.equal(five.surround, true)
  assert.match(argAfter(five.args, '-af'), /pan=5\.1\|c0=1\*c0\|c1=1\*c1\|c2=1\*c2\|c3=0\*c0/)
  const unknown = plan(track('dts', 12, 'weird'), { s: 1 })
  assert.equal(unknown.surround, false, 'unmixable layout becomes stereo, and says so')
  assert.equal(unknown.mixedDown, true)
})

test('plan: 7.1 becomes 5.1 for surround (with a limiter) and stereo otherwise', () => {
  const t = track('truehd', 8, '7.1')
  const s = plan(t, { s: 1, c: 'eac3' })
  assert.equal(s.channels, 6)
  const af = argAfter(s.args, '-af')
  assert.match(af, /pan=5\.1\|c0=1\*c0\|c1=1\*c1\|c2=1\*c2\|c3=1\*c3\|c4=0\.707\*c4\+0\.707\*c6\|c5=0\.707\*c5\+0\.707\*c7/)
  assert.ok(af.endsWith(ha.LIMITER_FILTER))
  assert.equal(plan(t, null).channels, 2)
})

test('plan: an exact 5.1 source into surround is not remixed and gets no limiter', () => {
  const s = plan(track('dts', 6, '5.1'), { s: 1 })
  assert.equal(argAfter(s.args, '-af'), 'aresample=48000:async=1:first_pts=0')
})

test('plan: copy (direct stream) only for HLS-safe codecs the client listed, with nothing to process', () => {
  const au = { s: 1, k: 'aac,ac3,eac3', x: 6 }
  for (const [codec, n, layout] of [['aac', 6, '5.1'], ['ac3', 6, '5.1'], ['eac3', 6, '5.1(side)'], ['aac', 2, 'stereo'], ['ac3', 2, 'stereo'], ['eac3', 1, 'mono']]) {
    const p = plan(track(codec, n, layout), au)
    assert.equal(p.kind, 'copy', `${codec} ${n}`)
    assert.deepEqual(p.args, ['-c:a', 'copy', '-copypriorss', '0'])
  }
  for (const [codec, n, layout] of [['dts', 6, '5.1'], ['truehd', 8, '7.1'], ['opus', 6, '5.1'], ['flac', 2, 'stereo'], ['mp3', 2, 'stereo'], ['vorbis', 2, 'stereo']]) {
    assert.equal(plan(track(codec, n, layout), au).kind, 'encode', `${codec} must be converted`)
  }
  assert.equal(plan(track('eac3', 8, '7.1'), au).kind, 'encode', 'more than six channels is never copied')
  assert.equal(plan(track('aac', 6, '5.1'), { s: 1, k: 'ac3,eac3', x: 6 }).kind, 'encode', 'codec the client did not list')
  assert.equal(plan(track('aac', 6, '5.1'), null).kind, 'encode', 'old clients never get a copy')
  assert.equal(plan(track('aac', 6, '5.1'), { s: 1 }).kind, 'encode', 'surround alone is not passthrough')
})

test('plan: a stereo-only client never receives a copied 5.1 track', () => {
  const p = plan(track('ac3', 6, '5.1'), { k: 'aac,ac3', x: 2 })
  assert.equal(p.kind, 'encode')
  assert.equal(p.mixedDown, true)
  assert.equal(plan(track('ac3', 2, 'stereo'), { k: 'aac,ac3', x: 2 }).kind, 'copy')
})

test('plan: any filter (night, levelling, delay) forces a re-encode even when copy is allowed', () => {
  for (const extra of [{ n: 1 }, { l: 1 }, { d: 40 }, { d: -40 }]) {
    const p = plan(track('eac3', 6, '5.1(side)'), { s: 1, k: 'eac3', x: 6, ...extra })
    assert.equal(p.kind, 'encode', JSON.stringify(extra))
  }
})

test('plan: night mode = compressor then limiter, after the mix-down', () => {
  const p = plan(track('eac3', 6, '5.1(side)'), { n: 1 })
  const af = argAfter(p.args, '-af').split(',')
  const iPan = af.findIndex((x) => x.startsWith('pan='))
  const iNight = af.findIndex((x) => x.startsWith('acompressor='))
  assert.ok(iPan > 0 && iNight > iPan)
  assert.equal(af[af.length - 1], ha.LIMITER_FILTER)
  assert.match(ha.NIGHT_FILTER, /^acompressor=threshold=0\.07:ratio=2\.5:/)
  // Night mode on a stereo track still builds a chain and keeps -ac 2.
  const st = plan(track('aac', 2, 'stereo'), { n: 1 })
  assert.equal(argAfter(st.args, '-af'), `aresample=48000:async=1:first_pts=0,${ha.NIGHT_FILTER},${ha.LIMITER_FILTER}`)
  assert.equal(argAfter(st.args, '-ac'), '2')
  const mono = plan(track('aac', 1, 'mono'), { n: 1 })
  assert.equal(argAfter(mono.args, '-ac'), '2')
})

test('plan: volume levelling is loudnorm followed by a return to 48 kHz', () => {
  const p = plan(track('aac', 2, 'stereo'), { l: 1 })
  assert.equal(argAfter(p.args, '-af'), `aresample=48000:async=1:first_pts=0,${ha.NORMALIZE_FILTER},aresample=48000`)
  const both = argAfter(plan(track('aac', 2, 'stereo'), { l: 1, n: 1 }).args, '-af')
  assert.ok(both.indexOf('acompressor') < both.indexOf('loudnorm'))
  assert.match(ha.NORMALIZE_NOTE, /core/)
})

test('plan: audio delay - positive pads silence, negative trims the start; both keep clocks honest', () => {
  const pos = argAfter(plan(track('aac', 2, 'stereo'), { d: 120 }).args, '-af')
  assert.equal(pos, 'aresample=48000:async=1:first_pts=0,adelay=120:all=1')
  const neg = argAfter(plan(track('aac', 2, 'stereo'), { d: -250 }).args, '-af')
  assert.equal(neg, 'aresample=48000:async=1:first_pts=0,atrim=start=0.25,asetpts=PTS-STARTPTS')
  const withMix = argAfter(plan(track('eac3', 6, '5.1(side)'), { d: -10 }).args, '-af')
  assert.match(withMix, /pan=stereo\|.*,atrim=start=0\.01,asetpts=PTS-STARTPTS,alimiter/)
})

// ---------------------------------------------------- inside the whole command
test('command: default request for a 5.1 film maps one audio stream and mixes down', () => {
  const args = build(track('eac3', 6, '5.1(side)'))
  assert.equal(argAfter(args, '-map'), '0:0')
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-map'), ['0:0', '0:1'])
  assert.match(argAfter(args, '-af'), /^aresample=48000:async=1:first_pts=0,pan=stereo\|/)
  assert.equal(argAfter(args, '-c:a'), 'aac')
  assert.equal(argAfter(args, '-ac'), '2')
})

test('command: with no audio argument at all, the audio options equal the original hard-coded ones for stereo', () => {
  const args = hls.buildTranscodeArgs({ input: 'f.mp4', tracks: tracksWith(track('ac3', 2, 'stereo')), quality: '480p', encoder: 'libx264', outDir: 'o' })
  assert.deepEqual(audioArgs(args), ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k'])
})

test('command: paths with spaces and unusual characters stay single arguments', () => {
  const input = 'C:\\Movies & TV\\My Film (2020) [Director\'s Cut] 5.1.mkv'
  const outDir = 'C:\\Temp Dir\\beebo hls\\abc'
  const args = hls.buildTranscodeArgs({ input, tracks: tracksWith(track('dts', 6, '5.1')), quality: '1080p', encoder: 'libx264', outDir, audio: { s: 1, c: 'eac3' }, audioEncoders: { aac: true, ac3: true, eac3: true }, startNumber: 3 })
  assert.equal(argAfter(args, '-i'), 'file:' + input)
  assert.equal(argAfter(args, '-protocol_whitelist'), 'file,crypto,pipe')
  assert.equal(argAfter(args, '-hls_segment_filename'), path.join(outDir, 'seg-%d.ts'))
  assert.equal(args.filter((a) => a === 'file:' + input).length, 1)
  assert.ok(args.every((a) => typeof a === 'string'))
  assert.equal(argAfter(args, '-c:a'), 'eac3')
  assert.equal(argAfter(args, '-b:a'), '640k')
})

test('command: surround, copy and night for many source codecs never break the piece plumbing', () => {
  const sources = [
    track('aac', 2, 'stereo'), track('ac3', 6, '5.1'), track('eac3', 6, '5.1(side)'), track('dts', 6, '5.1'), track('truehd', 8, '7.1'),
    track('opus', 6, '5.1'), track('flac', 2, 'stereo'), track('mp3', 2, ''), track('aac', 1, 'mono'), track('dts', 7, '6.1'), track('eac3', 8, '7.1')
  ]
  const audios = [null, { s: 1 }, { s: 1, c: 'eac3', k: 'aac,ac3,eac3', x: 6 }, { n: 1 }, { m: 'dialogue', l: 1 }, { d: 200 }, { s: 1, k: 'aac,ac3,eac3', x: 6, n: 1 }]
  for (const t of sources) {
    for (const au of audios) {
      for (const startNumber of [0, 12]) {
        const args = build(t, au, { startNumber })
        assert.equal(argAfter(args, '-force_key_frames'), 'expr:gte(t,n_forced*4)', 'piece boundaries do not depend on audio')
        assert.equal(argAfter(args, '-hls_time'), '4')
        assert.equal(argAfter(args, '-start_number'), String(startNumber))
        assert.equal(argAfter(args, '-output_ts_offset'), startNumber ? '48.000' : undefined)
        assert.equal(argAfter(args, '-g'), '96')
        assert.ok(args.includes('-c:a'))
        const same = build(t, au, { startNumber })
        assert.deepEqual(args, same, 'deterministic')
        // -af, when present, is one string and ffmpeg cannot see two audio filter lists.
        assert.ok(args.filter((a) => a === '-af').length <= 1)
      }
    }
  }
})

test('command: the video chain and picture-subtitle overlay are untouched by audio choices', () => {
  const args = hls.buildTranscodeArgs({ input: 'f.mkv', tracks: { ...tracksWith(track('dts', 6, '5.1')), subtitles: [{ streamIndex: 4, kind: 'image' }] }, quality: '1080p', encoder: 'h264_nvenc', burnSubtitleStreamIndex: 4, outDir: 'o', audio: { s: 1, n: 1 } })
  assert.match(argAfter(args, '-filter_complex'), /^\[0:0\]\[0:4\]overlay=/)
  assert.equal(argAfter(args, '-af') !== undefined, true)
  assert.equal(args.includes('-vf'), false)
})

test('audioPlanFor picks the chosen track, not the default', () => {
  const tracks = { durationSec: 10, video: null, audio: [track('eac3', 6, '5.1(side)', { streamIndex: 1, isDefault: true }), track('ac3', 2, 'stereo', { streamIndex: 2, isDefault: false, ordinal: 1 })], subtitles: [] }
  const p = hls.audioPlanFor({ tracks, quality: '720p', audioStreamIndex: 2, audio: { s: 1 } })
  assert.equal(p.sourceChannels, 2)
  assert.equal(hls.audioPlanFor({ tracks, quality: '720p', audio: { s: 1 } }).sourceChannels, 6)
  assert.equal(hls.audioPlanFor({ tracks, quality: '720p', audioStreamIndex: 99 }).sourceChannels, 6, 'unknown index falls back to the default')
})

// ------------------------------------------------------------ audio encoders
test('audio encoder detection reads ffmpeg -encoders; AAC is always assumed', () => {
  const listing = ' A....D aac                  AAC (Advanced Audio Coding)\n A....D ac3                  ATSC A/52A (AC-3)\n A....D eac3                 ATSC A/52 E-AC-3\n A....D ac3_fixed            fixed\n'
  assert.deepEqual(hls.audioEncodersFrom(listing), { aac: true, ac3: true, eac3: true })
  assert.deepEqual(hls.audioEncodersFrom(' A....D aac  AAC\n A....D ac3_fixed x\n'), { aac: true, ac3: false, eac3: false }, 'ac3_fixed alone is not ac3')
  assert.deepEqual(hls.audioEncodersFrom(''), { aac: true, ac3: false, eac3: false })
  assert.deepEqual(hls.audioEncodersFrom(null), { aac: true, ac3: false, eac3: false })
  assert.doesNotMatch(JSON.stringify(ha), /fdk/)
})

test('probeEncoders reports the audio encoders next to the video one', async () => {
  const run = async (args) => {
    if (args.includes('-encoders')) return { code: 0, stdout: ' V....D libx264 x264\n A....D aac AAC\n A....D ac3 AC3\n A....D eac3 EAC3\n' }
    if (args.includes('-filters')) return { code: 0, stdout: '' }
    return { code: 0, stdout: '' }
  }
  const r = await hls.probeEncoders({ ffmpegPath: 'ffmpeg', run })
  assert.equal(r.encoder, 'libx264')
  assert.deepEqual(r.audio, { aac: true, ac3: true, eac3: true })
  assert.deepEqual((await hls.probeEncoders({ ffmpegPath: null })).audio, { aac: false, ac3: false, eac3: false })
})

// -------------------------------------------------------------- honest labels
test('labels: plain words that match what is really playing', () => {
  const d = (t, au) => ha.describeAudio(plan(t, au))
  assert.deepEqual(d(track('ac3', 6, '5.1'), { s: 1, k: 'ac3', x: 6 }), { label: 'Surround 5.1 · Dolby Digital', detail: 'original audio, not re-encoded' })
  assert.deepEqual(d(track('eac3', 6, '5.1(side)'), null), { label: 'Stereo (mixed down from 5.1) · AAC', detail: 'converted from Dolby Digital Plus' })
  assert.deepEqual(d(track('dts', 6, '5.1'), { s: 1, c: 'eac3' }), { label: 'Surround 5.1 · Dolby Digital Plus', detail: 'converted from DTS' })
  assert.deepEqual(d(track('aac', 6, '5.1'), { s: 1 }), { label: 'Surround 5.1 · AAC', detail: 're-encoded for streaming' })
  assert.deepEqual(d(track('truehd', 8, '7.1'), { s: 1 }), { label: 'Surround 5.1 · AAC', detail: 'converted from Dolby TrueHD' })
  assert.equal(d(track('aac', 2, 'stereo'), { n: 1 }).label, 'Stereo · AAC')
  assert.match(d(track('aac', 2, 'stereo'), { n: 1 }).detail, /night mode/)
  assert.match(d(track('eac3', 6, '5.1(side)'), { m: 'dialogue' }).detail, /dialogue boosted/)
  assert.match(d(track('aac', 2, 'stereo'), { d: -90 }).detail, /-90 ms delay/)
  assert.match(d(track('aac', 2, 'stereo'), { l: 1 }).detail, /volume levelled/)
  assert.equal(ha.describeAudio(plan(track('aac', 1, 'mono'), null)).label, 'Stereo · AAC')
})

test('labels never claim Atmos, DTS:X or lossless; object audio is only mentioned to say it is dropped', () => {
  const sources = [
    track('truehd', 8, '7.1', { profile: 'Dolby TrueHD + Dolby Atmos' }),
    track('eac3', 6, '5.1(side)', { profile: 'Dolby Digital Plus + Dolby Atmos' }),
    track('dts', 8, '7.1', { profile: 'DTS-HD MA + DTS:X' }),
    track('dts', 6, '5.1', { profile: 'DTS-HD MA' }),
    track('flac', 6, '5.1(side)'), track('truehd', 6, '5.1')
  ]
  const modes = [null, { s: 1 }, { s: 1, c: 'eac3' }, { s: 1, k: 'aac,ac3,eac3', x: 6 }, { n: 1 }]
  for (const t of sources) {
    for (const au of modes) {
      const out = ha.describeAudio(plan(t, au))
      const text = `${out.label} | ${out.detail}`
      assert.doesNotMatch(out.label, /atmos|dts:x|lossless|truehd atmos|hd master/i, text)
      assert.doesNotMatch(out.detail, /lossless/i, text)
      if (/atmos|dts:x/i.test(out.detail)) assert.match(out.detail, /not kept/, text)
    }
  }
  assert.match(ha.describeAudio(plan(track('truehd', 8, '7.1', { profile: 'Dolby TrueHD + Dolby Atmos' }), { s: 1 })).detail, /object audio is not kept/)
  const src = ha.describeSourceTrack(track('truehd', 8, '7.1', { profile: 'Dolby TrueHD + Dolby Atmos' }))
  assert.equal(src.label, 'Surround 7.1 · Dolby TrueHD')
  assert.doesNotMatch(src.label + src.detail, /atmos|lossless/i)
  assert.equal(ha.describeSourceTrack(track('ac3', 6, '5.1')).label, 'Surround 5.1 · Dolby Digital')
  assert.equal(ha.describeSourceTrack(track('aac', 2, 'stereo')).label, 'Stereo · AAC')
  assert.equal(ha.describeSourceTrack(null).label, 'No sound')
})

// ------------------------------------------------------------ remembered prefs
test('audio prefs: defaults, validation, and patches that ignore what is not valid', () => {
  assert.deepEqual(ha.audioPrefs.read(undefined), { audioMode: 'auto', downmix: 'standard', night: false, normalize: false, boostDb: 0, audioDelayMs: 0 })
  assert.deepEqual(ha.audioPrefs.read({ audioMode: 'nope', night: 'yes', boostDb: 99, audioDelayMs: 9e9, downmix: 5 }), { audioMode: 'auto', downmix: 'standard', night: false, normalize: false, boostDb: 6, audioDelayMs: 500 })
  assert.deepEqual(ha.audioPrefs.patch({}, { audioMode: 'surround', night: true, boostDb: 3.3, audioDelayMs: -70.4 }), { audioMode: 'surround', night: true, boostDb: 3.5, audioDelayMs: -70 })
  assert.deepEqual(ha.audioPrefs.patch({}, { audioMode: 'evil', downmix: 1, night: 'true', normalize: null, boostDb: 'loud', audioDelayMs: NaN }), {})
  assert.deepEqual(ha.audioPrefs.patch({}, null), {})
  assert.equal(ha.audioPrefs.patch({}, { boostDb: -5 }).boostDb, 0)
  assert.equal(ha.audioPrefs.patch({}, { boostDb: 50 }).boostDb, ha.BOOST_LIMIT_DB)
})

// ------------------------------------------------------- real ffmpeg measurements
function ff(args, opts = {}) {
  return spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-v', 'error', ...args], { maxBuffer: 1 << 28, windowsHide: true, ...opts })
}

/** Synthetic input: one sine per channel; amp per channel (0 silences it). Returns raw f32le path. */
function makeTone(dir, layout, freqs, amps, seconds = 2) {
  const exprs = freqs.map((f, i) => (amps[i] ? `${amps[i]}*sin(2*PI*${f}*t)` : '0')).join('|')
  const out = path.join(dir, `tone-${crypto.randomBytes(3).toString('hex')}.wav`)
  const r = ff(['-y', '-f', 'lavfi', '-i', `aevalsrc=${exprs}:c=${layout}:s=48000:d=${seconds}`, '-c:a', 'pcm_f32le', out])
  assert.equal(r.status, 0, String(r.stderr))
  return out
}

/** Runs a plan's audio options over a file to raw float samples; returns per-channel peak and rms. */
function measure(input, planned, channels) {
  const afIndex = planned.args.indexOf('-af')
  const af = afIndex >= 0 ? ['-af', planned.args[afIndex + 1]] : ['-ac', String(channels)]
  const r = ff(['-i', input, ...af, '-f', 'f32le', '-ar', '48000', '-ac', String(channels), '-'])
  assert.equal(r.status, 0, String(r.stderr))
  const buf = r.stdout
  const total = buf.length / 4 / channels
  const peak = new Array(channels).fill(0)
  const sq = new Array(channels).fill(0)
  const skip = 4800
  for (let i = skip; i < total; i++) {
    for (let c = 0; c < channels; c++) {
      const v = buf.readFloatLE((i * channels + c) * 4)
      if (Math.abs(v) > peak[c]) peak[c] = Math.abs(v)
      sq[c] += v * v
    }
  }
  return { peak, rms: sq.map((s) => Math.sqrt(s / (total - skip))), samples: total }
}

const db = (x) => 20 * Math.log10(x)
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (+-${tol})`)

test('real audio: standard downmix puts each speaker where it belongs, at the documented levels', { skip: SKIP, timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-aud-'))
  try {
    const t = track('eac3', 6, '5.1')
    const std = plan(t, null)
    const dia = plan(t, { m: 'dialogue' })
    const only = (idx) => makeTone(dir, '5.1', [220, 330, 440, 55, 550, 660], [0, 1, 2, 3, 4, 5].map((i) => (i === idx ? 0.5 : 0)))
    const sine = 0.5 / Math.SQRT2
    const cases = [
      { name: 'FL', idx: 0, expect: [1.0, 0] },
      { name: 'FR', idx: 1, expect: [0, 1.0] },
      { name: 'FC', idx: 2, expect: [0.707, 0.707] },
      { name: 'LFE', idx: 3, expect: [0.3, 0.3] },
      { name: 'BL', idx: 4, expect: [0.707, 0] },
      { name: 'BR', idx: 5, expect: [0, 0.707] }
    ]
    for (const c of cases) {
      const m = measure(only(c.idx), std, 2)
      c.expect.forEach((gain, side) => {
        if (gain === 0) assert.ok(m.rms[side] < 0.002, `${c.name}: side ${side} silent (${m.rms[side]})`)
        else near(m.rms[side], sine * gain, sine * gain * 0.06, `${c.name} side ${side}`)
      })
    }
    const fcStd = measure(only(2), std, 2)
    const fcDia = measure(only(2), dia, 2)
    near(db(fcDia.rms[0] / fcStd.rms[0]), 3.0, 0.3, 'dialogue mode lifts speech about 3 dB')
    const blStd = measure(only(4), std, 2)
    const blDia = measure(only(4), dia, 2)
    assert.ok(blDia.rms[0] < blStd.rms[0], 'surrounds are lower in dialogue mode')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real audio: full-scale surround test vectors never clip after the mix-down', { skip: SKIP, timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-aud-'))
  try {
    const t = track('truehd', 6, '5.1')
    const coherent = makeTone(dir, '5.1', [440, 440, 440, 440, 440, 440], [1, 1, 1, 1, 1, 1])
    const incoherent = makeTone(dir, '5.1', [220, 330, 440, 55, 550, 660], [1, 1, 1, 1, 1, 1])
    for (const au of [null, { m: 'dialogue' }, { n: 1 }, { m: 'dialogue', n: 1 }]) {
      for (const file of [coherent, incoherent]) {
        const p = plan(t, au)
        const m = measure(file, p, 2)
        for (const pk of m.peak) assert.ok(pk <= 0.9, `peak ${pk.toFixed(3)} <= 0.9 (-0.9 dBFS) with ${JSON.stringify(au)}`)
        assert.ok(m.rms[0] > 0.1, 'and it is not silenced by the limiter')
      }
    }
    // A 5.1 surround output is left alone (no mix), and a 7.1 fold to 5.1 is limited too.
    const s = plan(t, { s: 1 })
    const keep = measure(incoherent, s, 6)
    for (const pk of keep.peak) near(pk, 1, 0.02, 'straight 5.1 passes untouched')
    const seven = makeTone(dir, '7.1', [220, 330, 440, 55, 550, 660, 770, 880], [1, 1, 1, 1, 1, 1, 1, 1])
    const folded = measure(seven, plan(track('truehd', 8, '7.1'), { s: 1 }), 6)
    for (const pk of folded.peak) assert.ok(pk <= 0.9, `7.1 -> 5.1 peak ${pk.toFixed(3)}`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real audio: 7.1 folds side and back into the 5.1 surrounds, fronts and centre stay put', { skip: SKIP, timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-aud-'))
  try {
    const seven = (idx) => makeTone(dir, '7.1', [220, 330, 440, 55, 550, 660, 770, 880], [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i === idx ? 0.5 : 0)))
    const p = plan(track('truehd', 8, '7.1'), { s: 1 })
    const sine = 0.5 / Math.SQRT2
    // 7.1 order: FL FR FC LFE BL BR SL SR ; 5.1 out: FL FR FC LFE BL BR
    const expectations = [[0, 0, 1], [1, 1, 1], [2, 2, 1], [3, 3, 1], [4, 4, 0.707], [5, 5, 0.707], [6, 4, 0.707], [7, 5, 0.707]]
    for (const [src, dst, gain] of expectations) {
      const m = measure(seven(src), p, 6)
      near(m.rms[dst], sine * gain, sine * 0.06, `input ${src} -> output ${dst}`)
      m.rms.forEach((r, c) => { if (c !== dst) assert.ok(r < 0.003, `input ${src}: output ${c} silent (${r})`) })
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real audio: night mode makes loud and quiet parts closer without changing the sound of the quiet part much', { skip: SKIP, timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-aud-'))
  try {
    // 2 s quiet dialogue (-26 dBFS rms) then 2 s loud effects (-8 dBFS rms) in the centre, stereo output.
    const quiet = path.join(dir, 'q.wav')
    const loud = path.join(dir, 'l.wav')
    const both = path.join(dir, 'both.wav')
    assert.equal(ff(['-y', '-f', 'lavfi', '-i', 'aevalsrc=0.0707*sin(2*PI*300*t)|0.0707*sin(2*PI*300*t):s=48000:d=3', '-c:a', 'pcm_f32le', quiet]).status, 0)
    assert.equal(ff(['-y', '-f', 'lavfi', '-i', 'aevalsrc=1.0*sin(2*PI*120*t)|1.0*sin(2*PI*120*t):s=48000:d=3', '-c:a', 'pcm_f32le', loud]).status, 0)
    assert.equal(ff(['-y', '-i', quiet, '-i', loud, '-filter_complex', '[0][1]concat=n=2:v=0:a=1', '-c:a', 'pcm_f32le', both]).status, 0)
    const rmsAt = (planned, from, to) => {
      const af = planned.args[planned.args.indexOf('-af') + 1]
      const r = ff(['-i', both, '-af', `${af},atrim=start=${from}:end=${to}`, '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'])
      const b = r.stdout
      let s = 0
      const n = b.length / 4
      for (let i = 0; i < n; i++) { const v = b.readFloatLE(i * 4); s += v * v }
      return Math.sqrt(s / n)
    }
    const off = plan(track('aac', 2, 'stereo'), { d: 1 })
    const on = plan(track('aac', 2, 'stereo'), { n: 1 })
    // Skip the compressor's attack/settling: measure the last second of each part.
    const spreadOff = db(rmsAt(off, 5, 5.9) / rmsAt(off, 2, 2.9))
    const spreadOn = db(rmsAt(on, 5, 5.9) / rmsAt(on, 2, 2.9))
    assert.ok(spreadOff > 12, `the test clip really is dynamic (${spreadOff.toFixed(1)} dB)`)
    assert.ok(spreadOn < spreadOff - 6, `night mode narrows the gap by at least 6 dB (${spreadOn.toFixed(1)} vs ${spreadOff.toFixed(1)})`)
    const quietOn = db(rmsAt(on, 2, 2.9) / rmsAt(off, 2, 2.9))
    assert.ok(quietOn > -1 && quietOn < 6, `quiet dialogue is not turned down (${quietOn.toFixed(1)} dB change)`)
    const loudPeak = ff(['-i', both, '-af', on.args[on.args.indexOf('-af') + 1], '-f', 'f32le', '-ac', '1', '-'])
    let pk = 0
    for (let i = 0; i < loudPeak.stdout.length / 4; i++) pk = Math.max(pk, Math.abs(loudPeak.stdout.readFloatLE(i * 4)))
    assert.ok(pk <= 0.9, `and the loud part is limited to -1 dBFS (${pk.toFixed(3)})`)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

function impulsePosition(filterArgs, channels, layout, atSec = 1.0, extra = []) {
  const n = 48000 * 3
  const buf = Buffer.alloc(n * channels * 4)
  for (let c = 0; c < channels; c++) buf.writeFloatLE(0.6, (Math.round(48000 * atSec) * channels + c) * 4)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-imp-'))
  try {
    const file = path.join(dir, 'imp.f32')
    fs.writeFileSync(file, buf)
    const outCh = 2
    const r = ff(['-f', 'f32le', '-ar', '48000', '-ac', String(channels), '-i', file, ...filterArgs, '-f', 'f32le', '-ar', '48000', '-ac', String(outCh), ...extra, '-'])
    assert.equal(r.status, 0, String(r.stderr))
    let best = 0
    let idx = -1
    const total = r.stdout.length / 4 / outCh
    for (let i = 0; i < total; i++) {
      const v = Math.abs(r.stdout.readFloatLE(i * outCh * 4))
      if (v > best) { best = v; idx = i }
    }
    return { idx, seconds: idx / 48000, best }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('real audio: sync - none of the audio chains move the sound by more than 10 ms', { skip: SKIP, timeout: 120000 }, () => {
  const cases = [
    ['downmix + limiter', plan(track('ac3', 6, '5.1'), null), 6],
    ['night', plan(track('aac', 2, 'stereo'), { n: 1 }), 2],
    ['levelling', plan(track('aac', 2, 'stereo'), { l: 1 }), 2],
    ['dialogue', plan(track('ac3', 6, '5.1'), { m: 'dialogue' }), 6],
    ['stereo default', plan(track('aac', 2, 'stereo'), null), 2],
    ['async resample only', plan(track('aac', 2, 'stereo'), { d: 1 }), 2]
  ]
  for (const [name, p, ch] of cases) {
    const af = p.args.indexOf('-af') >= 0 ? ['-af', p.args[p.args.indexOf('-af') + 1]] : []
    const m = impulsePosition(af, ch, ch === 6 ? '5.1' : 'stereo')
    const expected = name === 'async resample only' ? 1.001 : 1.0
    near(m.seconds, expected, 0.010, `${name}: impulse lands at 1.000 s`)
    assert.ok(m.best > 0.05, `${name}: still there`)
  }
})

test('real audio: delay shifts the sound by exactly the asked-for time, both directions', { skip: SKIP, timeout: 120000 }, () => {
  for (const ms of [200, 500, -200, -500, 40]) {
    const p = plan(track('aac', 2, 'stereo'), { d: ms })
    const m = impulsePosition(['-af', p.args[p.args.indexOf('-af') + 1]], 2, 'stereo')
    near(m.seconds, 1 + ms / 1000, 0.003, `${ms} ms`)
  }
})

// Synthetic sources use whichever H.264-class encoder this ffmpeg has: the bundled LGPL build has no libx264.
const synthVideo = () => { const l = String(ff(['-encoders']).stdout || ''); return /libx264/.test(l) ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : /libopenh264/.test(l) ? ['-c:v', 'libopenh264'] : ['-c:v', 'mpeg4'] }

test('real conversion: 5.1 sources come out as 5.1 AC-3/E-AC-3/AAC, copy stays untouched, default stays stereo AAC', { skip: SKIP, timeout: 300000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-aud-hls-'))
  try {
    const listing = String(ff(['-encoders']).stdout || '')
    const enc = hls.audioEncodersFrom(listing)
    const tone = (cfg) => `aevalsrc=${[0, 1, 2, 3, 4, 5].map((i) => `0.4*sin(2*PI*${[220, 330, 440, 55, 550, 660][i]}*t)`).join('|')}:c=${cfg}:s=48000:d=9`
    const makeSource = (name, acodec, layout, extra = []) => {
      const out = path.join(dir, name)
      const r = ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=9', '-f', 'lavfi', '-i', tone(layout), '-map', '0:v', '-map', '1:a', ...synthVideo(), '-pix_fmt', 'yuv420p', '-c:a', acodec, ...extra, '-shortest', out])
      return r.status === 0 ? out : null
    }
    const probeTracks = (file) => {
      const j = spawnSync(FFPROBE, [...localRequire('./electron/playbackTracks').PROBE_ARGS, file], { encoding: 'utf8', windowsHide: true })
      return localRequire('./electron/playbackTracks').parseTracks(JSON.parse(j.stdout))
    }
    const probeOut = (file) => {
      const j = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels,channel_layout,bit_rate', '-of', 'json', file], { encoding: 'utf8', windowsHide: true })
      return JSON.parse(j.stdout).streams[0]
    }
    const encoderInfo = await hls.probeEncoders({ ffmpegPath: FFMPEG })
    if (!encoderInfo.encoder) return
    const runHls = (input, audio, tag) => {
      const tracks = probeTracks(input)
      const outDir = path.join(dir, tag)
      fs.mkdirSync(outDir, { recursive: true })
      const args = hls.buildTranscodeArgs({ input, tracks, quality: '480p', encoder: encoderInfo.encoder, outDir, audio, audioEncoders: enc })
      const r = spawnSync(FFMPEG, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 })
      assert.equal(r.status, 0, `${tag}: ${r.stderr}`)
      const segs = fs.readdirSync(outDir).filter((f) => /^seg-\d+\.ts$/.test(f)).sort((a, b) => Number(a.slice(4, -3)) - Number(b.slice(4, -3)))
      assert.ok(segs.length >= 2, `${tag}: pieces made`)
      return { outDir, segs, first: path.join(outDir, segs[0]), last: path.join(outDir, segs[segs.length - 1]) }
    }

    const ac3Src = makeSource('src-ac3.mkv', 'ac3', '5.1', ['-b:a', '448k'])
    const aacSrc = makeSource('src-aac.mp4', 'aac', '5.1', ['-b:a', '384k'])
    const dts = makeSource('src-dts.mkv', 'dca', '5.1', ['-strict', '-2'])
    assert.ok(ac3Src && aacSrc, 'synthetic sources')

    const def = runHls(ac3Src, null, 'default')
    const d = probeOut(def.first)
    assert.equal(d.codec_name, 'aac')
    assert.equal(Number(d.channels), 2)

    const surroundAac = runHls(ac3Src, { s: 1 }, 'surround-aac')
    const a = probeOut(surroundAac.first)
    assert.equal(a.codec_name, 'aac')
    assert.equal(Number(a.channels), 6)

    if (enc.eac3) {
      const e = probeOut(runHls(ac3Src, { s: 1, c: 'eac3' }, 'surround-eac3').first)
      assert.equal(e.codec_name, 'eac3')
      assert.equal(Number(e.channels), 6)
    }
    if (enc.ac3) {
      const e = probeOut(runHls(aacSrc, { s: 1, c: 'ac3' }, 'surround-ac3').first)
      assert.equal(e.codec_name, 'ac3')
      assert.equal(Number(e.channels), 6)
    }
    // Direct stream: the audio is not re-encoded (same codec, same channel count), video still converted.
    const copyAc3 = probeOut(runHls(ac3Src, { s: 1, k: 'aac,ac3,eac3', x: 6 }, 'copy-ac3').first)
    assert.equal(copyAc3.codec_name, 'ac3')
    assert.equal(Number(copyAc3.channels), 6)
    const copyAac = runHls(aacSrc, { s: 1, k: 'aac', x: 6 }, 'copy-aac')
    const ca = probeOut(copyAac.first)
    assert.equal(ca.codec_name, 'aac')
    assert.equal(Number(ca.channels), 6)
    const vid = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width', '-of', 'csv=p=0', copyAac.first], { encoding: 'utf8' })
    assert.match(vid.stdout, /^h264,\d+/, 'video is still converted to H.264 at the chosen quality')
    if (dts) {
      const conv = probeOut(runHls(dts, { s: 1, k: 'aac,ac3,eac3', x: 6 }, 'dts-surround').first)
      assert.ok(['aac', 'ac3', 'eac3'].includes(conv.codec_name), 'DTS is never copied into HLS')
      assert.equal(Number(conv.channels), 6)
    }
    // Night mode + dialogue downmix through the full command.
    const night = probeOut(runHls(ac3Src, { n: 1, m: 'dialogue' }, 'night').first)
    assert.equal(night.codec_name, 'aac')
    assert.equal(Number(night.channels), 2)
    // Pieces from a seek run (later start) carry the same audio format as run one: boundaries hold.
    const tracks = probeTracks(ac3Src)
    const seekDir = path.join(dir, 'seek')
    fs.mkdirSync(seekDir)
    const seekArgs = hls.buildTranscodeArgs({ input: ac3Src, tracks, quality: '480p', encoder: encoderInfo.encoder, outDir: seekDir, audio: { s: 1, c: 'eac3' }, audioEncoders: enc, startNumber: 1 })
    const sr = spawnSync(FFMPEG, seekArgs, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 })
    assert.equal(sr.status, 0, sr.stderr)
    const firstSeek = fs.readdirSync(seekDir).filter((f) => /^seg-\d+\.ts$/.test(f)).sort()[0]
    assert.equal(firstSeek, 'seg-1.ts', 'numbering starts at the seek point')
    const s2 = probeOut(path.join(seekDir, firstSeek))
    assert.equal(Number(s2.channels), 6)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real conversion: sound and picture stay lined up in a converted piece (no start offset between them)', { skip: SKIP, timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-aud-sync-'))
  try {
    const src = path.join(dir, 'src.mkv')
    const gen = ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=24', '-f', 'lavfi', '-i', 'aevalsrc=0.4*sin(2*PI*440*t)|0.4*sin(2*PI*440*t)|0.4*sin(2*PI*440*t)|0.4*sin(2*PI*55*t)|0.4*sin(2*PI*440*t)|0.4*sin(2*PI*440*t):c=5.1:s=48000:d=24', ...synthVideo(), '-g', '240', '-keyint_min', '240', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-b:a', '448k', src])
    assert.equal(gen.status, 0, String(gen.stderr))
    const encoderInfo = await hls.probeEncoders({ ffmpegPath: FFMPEG })
    if (!encoderInfo.encoder) return
    const enc = hls.audioEncodersFrom(String(ff(['-encoders']).stdout || ''))
    const pt = localRequire('./electron/playbackTracks')
    const tracks = pt.parseTracks(JSON.parse(spawnSync(FFPROBE, [...pt.PROBE_ARGS, src], { encoding: 'utf8' }).stdout))
    for (const [tag, audio, startNumber] of [['default', null, 0], ['surround', { s: 1, c: 'eac3' }, 0], ['night', { n: 1 }, 0], ['seeked', { s: 1 }, 1], ['delay', { d: -200 }, 0], ['copy', { s: 1, k: 'aac,ac3,eac3', x: 6 }, 0], ['copy-seeked', { s: 1, k: 'aac,ac3,eac3', x: 6 }, 2], ['copy-seeked-far', { s: 1, k: 'aac,ac3,eac3', x: 6 }, 4]]) {
      const outDir = path.join(dir, tag)
      fs.mkdirSync(outDir)
      const args = hls.buildTranscodeArgs({ input: src, tracks, quality: '480p', encoder: encoderInfo.encoder, outDir, audio, audioEncoders: enc, startNumber })
      const r = spawnSync(FFMPEG, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 })
      assert.equal(r.status, 0, `${tag}: ${r.stderr}`)
      const seg = path.join(outDir, `seg-${startNumber}.ts`)
      const j = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', seg], { encoding: 'utf8' }).stdout)
      const start = (type) => Number(j.streams.find((s) => s.codec_type === type).start_time)
      const av = start('audio') - start('video')
      const tolerance = tag === 'delay' ? 0.4 : tag.startsWith('copy') ? 0.06 : 0.12
      assert.ok(Math.abs(av) < tolerance, `${tag}: audio starts ${av.toFixed(3)} s from video`)
      assert.ok(start('video') >= startNumber * 4 - 0.1 && start('video') < startNumber * 4 + 1.8, `${tag}: video carries its place in the film (${start('video')})`)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
