// Phone speakers: which channel each phone plays and the ffmpeg command that cuts it (electron/phoneSpeakersChannels.js).
// The pure parts run everywhere; the "real ffmpeg" tests synthesize a 5.1 film with a different pure tone in every
// channel, run the command the server would run, decode the pieces and check every feed carries ONLY its own tone.
// Run: NODE_PATH=<desktop node_modules> node --test test/phone-speakers-channels.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ch = require('../electron/phoneSpeakersChannels')
const tracksLib = require('../electron/playbackTracks')
const fx = require('./phone-speakers-fixture')

const track = (channels, channelLayout, streamIndex = 0) => ({ channels, channelLayout, streamIndex, codec: 'eac3' })

// ------------------------------------------------------------------ pure
test('describeSource: 5.1, 5.1(side), 7.1, stereo, mono and rubbish', () => {
  const a = ch.describeSource(track(6, '5.1'))
  assert.equal(a.kind, 'surround'); assert.equal(a.hasLfe, true); assert.equal(a.hasBacks, true); assert.equal(a.hasSides, false)
  assert.deepEqual(a.roles, ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'])
  const b = ch.describeSource(track(6, '5.1(side)'))
  assert.equal(b.hasSides, true); assert.equal(b.words, '5.1')
  const c = ch.describeSource(track(8, '7.1'))
  assert.equal(c.channels, 8); assert.equal(c.hasSides && c.hasBacks, true)
  assert.equal(ch.describeSource(track(2, 'stereo')).kind, 'stereo')
  assert.equal(ch.describeSource(track(1, 'mono')).kind, 'mono')
  assert.equal(ch.describeSource(track(6, null)).kind, 'surround') // "6 channels" with no layout: ffmpeg's default (5.1 side)
  assert.equal(ch.describeSource(null).kind, 'none')
  assert.equal(ch.describeSource({ channels: 'x' }).channels, 0)
})

test('default mode and join order by film', () => {
  const s51 = ch.describeSource(track(6, '5.1(side)'))
  assert.equal(ch.defaultMode(s51), 'surround')
  assert.deepEqual(ch.seatOrder('surround', s51), ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE'])
  assert.deepEqual(ch.seatOrder('surround', ch.describeSource(track(8, '7.1'))), ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'BL', 'BR'])
  assert.deepEqual(ch.seatOrder('surround', ch.describeSource(track(5, '5.0(side)'))), ['FL', 'FR', 'FC', 'SL', 'SR'])
  assert.equal(ch.defaultMode(ch.describeSource(track(2, 'stereo'))), 'stereo')
  assert.deepEqual(ch.seatOrder('stereo', ch.describeSource(track(2, 'stereo'))), ['DL', 'DR'])
  assert.equal(ch.defaultMode(ch.describeSource(track(1, 'mono'))), 'everyone')
  assert.deepEqual(ch.seatOrder('everyone', s51), [])
  assert.deepEqual(ch.requiredFeeds('everyone', s51), ['DM'])
})

test('recipes: a real channel is copied, a missing one is derived (never silence)', () => {
  const roles = ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']
  assert.equal(ch.feedRecipe('FL', roles).filter, 'pan=mono|c0=1*c0')
  assert.equal(ch.feedRecipe('FC', roles).filter, 'pan=mono|c0=1*c2')
  assert.equal(ch.feedRecipe('SR', roles).filter, 'pan=mono|c0=1*c5')
  const lfe = ch.feedRecipe('LFE', roles)
  assert.match(lfe.filter, /^pan=mono\|c0=1\*c3\+0\.25\*c0\+0\.25\*c1\+0\.25\*c2,lowpass=f=120,lowpass=f=120,alimiter/)
  assert.equal(lfe.rate, ch.LFE_RATE)
  // a stereo film has no centre, no surrounds and no bass channel
  const st = ['FL', 'FR']
  assert.equal(ch.feedRecipe('FC', st).derived, true)
  assert.equal(ch.feedRecipe('FC', st).filter.startsWith('pan=mono|c0=0.707*c0+0.707*c1'), true)
  assert.equal(ch.feedRecipe('SL', st).filter, 'pan=mono|c0=0.5*c0')
  assert.equal(ch.feedRecipe('SR', st).filter, 'pan=mono|c0=0.5*c1')
  assert.equal(ch.feedRecipe('LFE', st).derived, true)
  // a mono film: every feed is that one channel
  for (const f of ['FL', 'FR', 'FC', 'DL', 'DR', 'DM']) assert.equal(ch.feedRecipe(f, ['FC']).filter, 'pan=mono|c0=1*c0', f)
  // 5.1 with a BACK pair feeds the surround seats
  assert.equal(ch.feedRecipe('SL', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR']).filter, 'pan=mono|c0=1*c4')
  // the 7.1 rear pair is its own feed, and a 5.1 film's "rear" falls back to the side channel
  assert.equal(ch.feedRecipe('BL', ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR']).filter, 'pan=mono|c0=1*c4')
  assert.equal(ch.feedRecipe('BL', roles).derived, true)
  assert.throws(() => ch.feedRecipe('XX', roles))
})

test('recipes: the stereo fold-down keeps the loudness of the mono sum in check', () => {
  const roles = ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']
  const dl = ch.feedRecipe('DL', roles).filter
  assert.ok(dl.includes('1*c0') && dl.includes('0.707*c2') && dl.includes('0.707*c4') && dl.includes('0.3*c3'), dl)
  assert.ok(!dl.includes('c1') && !dl.includes('c5'), dl)
  const dm = ch.feedRecipe('DM', roles).filter
  assert.ok(dm.includes('0.5*c0') && dm.includes('0.5*c1') && dm.includes('0.707*c2'), dm) // centre is in both sides: 0.354 + 0.354
  assert.ok(dm.endsWith('alimiter=limit=0.89:attack=5:release=50:level=0'), dm)
})

test('buildSessionArgs: one WAV run for several feeds, seek, old-PC profile, exact 50 ms frames', () => {
  const src = ch.describeSource(track(6, '5.1(side)', 1))
  const a = ch.buildSessionArgs({ input: 'C:\\movies\\film.mkv', source: src, feeds: ['FL', 'LFE', 'DM', 'FL'], startSegment: 0, outDir: 'out' })
  const s = a.join(' ')
  assert.ok(a.includes('-protocol_whitelist') && a.includes('file:C:\\movies\\film.mkv'))
  assert.ok(!a.includes('-ss'))
  assert.match(s, /\[0:1\]aresample=async=1:first_pts=0,asplit=3\[s0\]\[s1\]\[s2\]/)
  assert.match(s, /\[s0\]pan=mono\|c0=1\*c0,aresample=32000,asetnsamples=n=1600:p=0\[o0\]/)
  assert.match(s, /\[s1\]pan=mono\|c0=1\*c3.*aresample=8000,asetnsamples=n=400:p=0\[o1\]/)
  assert.equal(a.filter((x) => x === '-segment_time').length, 3)
  assert.equal(a[a.indexOf('-segment_time') + 1], '5')
  assert.ok(s.includes(path.join('out', 'FL-%d.wav')) && s.includes(path.join('out', 'LFE-%d.wav')) && s.includes(path.join('out', 'DM-%d.wav')))
  const seek = ch.buildSessionArgs({ input: 'x.mkv', source: src, feeds: ['FL'], startSegment: 7, outDir: 'o', rate: 48000 })
  assert.equal(seek[seek.indexOf('-ss') + 1], '35.000')
  assert.equal(seek[seek.indexOf('-segment_start_number') + 1], '7')
  assert.match(seek.join(' '), /aresample=48000,asetnsamples=n=2400/)
  const low = ch.buildSessionArgs({ input: 'x.mkv', source: src, feeds: ['FL'], outDir: 'o', profile: { tier: 'low', cores: 2, filterThreads: 1 } })
  assert.ok(low.includes('-threads') && low.includes('-filter_threads'))
  const flac = ch.buildSessionArgs({ input: 'x.mkv', source: src, feeds: ['FL'], outDir: 'o', codec: 'flac' })
  assert.ok(flac.includes('flac') && flac.join(' ').includes('FL-%d.flac'))
  assert.throws(() => ch.buildSessionArgs({ input: 'x.mkv', source: src, feeds: [], outDir: 'o' }), /no feeds/)
  assert.throws(() => ch.buildSessionArgs({ input: 'x.mkv', source: src, feeds: ['FL'], outDir: 'o', rate: 22050 }), /sample rate/)
  assert.throws(() => ch.buildSessionArgs({ input: 'x.mkv', source: { ...src, streamIndex: null }, feeds: ['FL'], outDir: 'o' }), /no audio track/)
  assert.throws(() => ch.buildSessionArgs({ input: 'x.mkv', source: src, feeds: ['FL'], outDir: 'o', codec: 'mp3' }), /codec/)
  assert.throws(() => ch.buildSessionArgs({ input: 'bad\nname.mkv', source: src, feeds: ['FL'], outDir: 'o' }))
  // every allowed rate divides a piece into whole 50 ms frames
  for (const r of ch.ALLOWED_RATES) assert.equal((r * ch.SEGMENT_SECONDS) % ch.framesFor(r), 0, String(r))
  assert.equal((ch.LFE_RATE * ch.SEGMENT_SECONDS) % ch.framesFor(ch.LFE_RATE), 0)
})

test('file names round-trip and hostile names are refused', () => {
  assert.equal(ch.segmentFile('FL', 12), 'FL-12.wav')
  assert.deepEqual(ch.parseSegmentFile('LFE-3.wav'), { feed: 'LFE', n: 3 })
  for (const bad of ['../FL-1.wav', 'FL-1.wav/../x', 'ZZ-1.wav', 'FL-x.wav', 'FL-1.wav.tmp', '', null]) assert.equal(ch.parseSegmentFile(bad), null, String(bad))
  assert.equal(ch.segmentCount(11), 3); assert.equal(ch.segmentCount(10), 2); assert.equal(ch.segmentCount(0), 0)
})

test('resolveLayers: everyone present, a phone leaves, TV fills in / folds into a neighbour / drops', () => {
  const src = ch.describeSource(track(6, '5.1(side)'))
  const full = new Map([['a', 'FL'], ['b', 'FR'], ['c', 'FC'], ['d', 'SL'], ['e', 'SR'], ['f', 'LFE']])
  let r = ch.resolveLayers({ mode: 'surround', source: src, seats: full, fillIn: 'tv' })
  assert.deepEqual(r.missing, []); assert.deepEqual(r.tv, [])
  assert.deepEqual(r.layers.a, [{ feed: 'FL', gain: 1 }])
  // SL's phone left
  const gone = new Map([['a', 'FL'], ['b', 'FR'], ['c', 'FC'], ['e', 'SR'], ['f', 'LFE']])
  r = ch.resolveLayers({ mode: 'surround', source: src, seats: gone, fillIn: 'tv' })
  assert.deepEqual(r.missing, ['SL']); assert.deepEqual(r.tv, [{ feed: 'SL', gain: 1 }])
  r = ch.resolveLayers({ mode: 'surround', source: src, seats: gone, fillIn: 'neighbour' })
  assert.deepEqual(r.tv, []); assert.deepEqual(r.layers.a, [{ feed: 'FL', gain: 1 }, { feed: 'SL', gain: 0.75 }], 'SL folds into the front-left phone')
})

test('resolveLayers: neighbour order, drop, no phones at all, stereo pair and everyone presets', () => {
  const src = ch.describeSource(track(6, '5.1(side)'))
  // SL folds to FL first (FC is not SL's neighbour), FL to FC
  let r = ch.resolveLayers({ mode: 'surround', source: src, seats: { a: 'FL', b: 'FR' }, fillIn: 'neighbour' })
  assert.ok(r.layers.a.some((l) => l.feed === 'SL')); assert.ok(r.layers.b.some((l) => l.feed === 'SR'))
  assert.ok(r.layers.a.some((l) => l.feed === 'FC'), 'the centre folds into the front-left phone')
  r = ch.resolveLayers({ mode: 'surround', source: src, seats: { a: 'FL', b: 'FR' }, fillIn: 'off' })
  assert.deepEqual(r.dropped.sort(), ['FC', 'LFE', 'SL', 'SR'])
  assert.deepEqual(r.tv, [])
  // nobody here: nothing is "missing" (the TV just plays its own sound)
  r = ch.resolveLayers({ mode: 'surround', source: src, seats: {}, fillIn: 'tv' })
  assert.deepEqual(r.missing, []); assert.deepEqual(r.tv, [])
  // stereo pair: only DL and DR matter
  r = ch.resolveLayers({ mode: 'stereo', source: src, seats: { a: 'DL' }, fillIn: 'tv' })
  assert.deepEqual(r.tv, [{ feed: 'DR', gain: 1 }])
  // everyone: every phone plays the mix, the TV adds nothing
  r = ch.resolveLayers({ mode: 'everyone', source: src, seats: { a: '', b: '' }, fillIn: 'tv' })
  assert.deepEqual(r.layers.a, [{ feed: 'DM', gain: 1 }]); assert.deepEqual(r.tv, [])
})

// ------------------------------------------------------------------ real ffmpeg
const haveFf = !!fx.FFMPEG
const skip = haveFf ? false : 'ffmpeg not found (set BEEBO_FFMPEG)'

function probe(file) {
  const r = spawnSync(fx.FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  return tracksLib.parseTracks(JSON.parse(r.stdout))
}

/** Runs the server's command; resolves the directory holding the pieces. */
function runSession(file, feeds, startSegment, rate = ch.DEFAULT_RATE) {
  const tracks = probe(file)
  const source = ch.describeSource(tracks.audio[0])
  const dir = fx.tmpDir()
  const args = ch.buildSessionArgs({ input: file, source, feeds, startSegment, outDir: dir, rate })
  const r = spawnSync(fx.FFMPEG, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr)
  return { dir, source, tracks }
}

// lavfi's sine has an amplitude of 1/8, so a channel's own tone measures -18 dB in tonePower's units.
const REF = fx.db(0.125 * 0.125)

test('real ffmpeg: every feed of a synthesized 5.1 film carries only its own tone', { skip }, () => {
  const dir0 = fx.tmpDir()
  const film = fx.makeTone51(path.join(dir0, 'tones51.mka'), 12)
  const feeds = ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'DL', 'DR', 'DM']
  const { dir, source } = runSession(film, feeds, 0)
  assert.equal(source.kind, 'surround'); assert.equal(source.roles.join(), 'FL,FR,FC,LFE,SL,SR')
  // level of `freq` in piece 0 of `feed`, relative to a channel's own tone at full strength
  const at = (feed, freq, n = 0) => {
    const w = fx.readWav(path.join(dir, `${feed}-${n}.wav`))
    assert.equal(w.rate, feed === 'LFE' ? ch.LFE_RATE : ch.DEFAULT_RATE, feed + ' rate'); assert.equal(w.channels, 1); assert.equal(w.bits, 16)
    return fx.db(fx.tonePower(w.samples, w.rate, freq, 2000)) - REF // skip the first 2000 samples (filter start-up)
  }
  const tone = fx.TONES
  // FL FR FC SL SR: their own tone at full level, every other channel's tone at least 60 dB down (i.e. absent)
  for (const feed of ['FL', 'FR', 'FC', 'SL', 'SR']) {
    const own = at(feed, tone[feed])
    assert.ok(Math.abs(own) < 0.5, `${feed} own tone ${own} dB`)
    for (const other of Object.keys(tone)) {
      if (other === feed) continue
      assert.ok(at(feed, tone[other]) < -60, `${feed} leaks ${other}: ${at(feed, tone[other])} dB`)
    }
  }
  // the bass feed: the LFE tone at full level; the (low-passed) main tones far below it. 8 kHz sampling cannot hold the highest tones cleanly, so only test the ones it can.
  assert.ok(Math.abs(at('LFE', tone.LFE)) < 1, 'LFE own (two low-pass stages cost half a dB at 60 Hz) ' + at('LFE', tone.LFE))
  for (const o of ['FL', 'FR', 'FC', 'SL']) assert.ok(at('LFE', tone[o]) < -40, `LFE leaks ${o}: ${at('LFE', tone[o])}`)
  // stereo fold-down: left = FL + 0.707 FC + 0.707 SL + 0.3 LFE, right = FR + 0.707 FC + 0.707 SR + 0.3 LFE; nothing of the other side
  const dl = (f) => at('DL', tone[f]); const dr = (f) => at('DR', tone[f])
  assert.ok(Math.abs(dl('FL')) < 0.5, 'DL FL ' + dl('FL'))
  assert.ok(Math.abs(dl('FC') + 3.01) < 0.5 && Math.abs(dl('SL') + 3.01) < 0.5, `DL FC/SL ${dl('FC')} ${dl('SL')}`)
  assert.ok(dl('FR') < -60 && dl('SR') < -60, 'DL has no right-hand channels')
  assert.ok(Math.abs(dr('FR')) < 0.5 && Math.abs(dr('FC') + 3.01) < 0.5 && Math.abs(dr('SR') + 3.01) < 0.5, 'DR')
  assert.ok(dr('FL') < -60 && dr('SL') < -60, 'DR has no left-hand channels')
  assert.ok(Math.abs(dl('LFE') + 10.46) < 0.5, 'the bass is folded in at 0.3 (-10.5 dB): ' + dl('LFE'))
  // everyone: all of them, at the halved-sum levels (FL 0.5, FC 0.707, SL 0.354)
  assert.ok(Math.abs(at('DM', tone.FL) + 6.02) < 0.5 && Math.abs(at('DM', tone.FR) + 6.02) < 0.5, 'DM fronts')
  assert.ok(Math.abs(at('DM', tone.FC) + 3.01) < 0.5, 'DM centre ' + at('DM', tone.FC))
  assert.ok(Math.abs(at('DM', tone.SL) + 9.03) < 0.5 && Math.abs(at('DM', tone.SR) + 9.03) < 0.5, 'DM surrounds')
  // every full piece holds exactly 5 s of samples: this is what lets phones chain them without a click
  for (const feed of feeds) {
    const perSec = feed === 'LFE' ? ch.LFE_RATE : ch.DEFAULT_RATE
    assert.equal(fx.readWav(path.join(dir, `${feed}-0.wav`)).samples.length, perSec * 5, `${feed}-0 length`)
    assert.equal(fx.readWav(path.join(dir, `${feed}-1.wav`)).samples.length, perSec * 5, `${feed}-1 length`)
    assert.ok(fs.existsSync(path.join(dir, `${feed}-2.wav`)), 'a short last piece exists')
  }
})

test('real ffmpeg: a stereo film gets a derived centre, surrounds and bass (the downmix fallback)', { skip }, () => {
  const dir0 = fx.tmpDir()
  const film = path.join(dir0, 'stereo.mka')
  fx.run(['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=554:sample_rate=48000:duration=6',
    '-filter_complex', '[0][1]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[a]', '-map', '[a]', '-c:a', 'flac', film])
  const { dir, source } = runSession(film, ['FL', 'FR', 'FC', 'SL', 'LFE', 'DM'], 0)
  assert.equal(source.kind, 'stereo')
  const p = (feed, f) => { const w = fx.readWav(path.join(dir, `${feed}-0.wav`)); return fx.db(fx.tonePower(w.samples, w.rate, f, 2000)) - REF }
  assert.ok(Math.abs(p('FL', 440)) < 0.5 && p('FL', 554) < -60)
  assert.ok(Math.abs(p('FR', 554)) < 0.5 && p('FR', 440) < -60)
  assert.ok(Math.abs(p('FC', 440) + 3.01) < 0.5 && Math.abs(p('FC', 554) + 3.01) < 0.5, 'the phantom centre has both sides at -3 dB')
  assert.ok(Math.abs(p('SL', 440) + 6.02) < 0.5 && p('SL', 554) < -60, 'surround-left is the front-left at half level')
  assert.equal(fx.readWav(path.join(dir, 'LFE-0.wav')).samples.length, ch.LFE_RATE * 5, 'the derived bass feed is a valid piece too')
  assert.ok(Math.abs(p('DM', 440) + 6.02) < 0.5 && Math.abs(p('DM', 554) + 6.02) < 0.5, 'the mix of a stereo film: both at half')
})
test('real ffmpeg: audio lands where the film says (a burst at 3.000 s), from the start and after a seek', { skip }, () => {
  const dir0 = fx.tmpDir()
  const film = fx.makeBurst(path.join(dir0, 'burst.mka'), { at: 3, seconds: 14 })
  // the same burst, seen from a run that starts at piece 0 and one that starts at piece 1 (a seek to 5 s)
  const a = runSession(film, ['FL'], 0)
  const w0 = fx.readWav(path.join(a.dir, 'FL-0.wav'))
  const o0 = fx.onset(w0.samples, 0.05)
  assert.ok(Math.abs(o0 / w0.rate - 3.0) < 0.002, `burst at ${o0 / w0.rate} s from a run at 0`)
  // and one at 8.000 s, found from a run that started at 5.000 s (piece 1)
  const film2 = fx.makeBurst(path.join(dir0, 'burst8.mka'), { at: 8, seconds: 14 })
  const b = runSession(film2, ['FL'], 1)
  const w1 = fx.readWav(path.join(b.dir, 'FL-1.wav'))
  const o1 = fx.onset(w1.samples, 0.05)
  assert.ok(Math.abs(5 + o1 / w1.rate - 8.0) < 0.002, `burst at ${5 + o1 / w1.rate} s from a run at 5 s`)
  assert.ok(!fs.existsSync(path.join(b.dir, 'FL-0.wav')), 'a seek run does not write earlier pieces')
})
