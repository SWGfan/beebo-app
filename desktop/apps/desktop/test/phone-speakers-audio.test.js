// Phone speakers: the audio piece manager (electron/phoneSpeakersAudio.js): lifecycle with a fake ffmpeg (seek restarts,
// far-ahead stop and resume, extra feeds, errors, the waiting line, idle / retention / size-limit cleanup, old-PC limits)
// and once with the real bundled ffmpeg, served the way a phone asks for pieces.
// Run: NODE_PATH=<desktop node_modules> node --test test/phone-speakers-audio.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const ch = require('../electron/phoneSpeakersChannels')
const audio = require('../electron/phoneSpeakersAudio')
const fx = require('./phone-speakers-fixture')

const source = ch.describeSource({ channels: 6, channelLayout: '5.1(side)', streamIndex: 1, codec: 'eac3' })

/** A fake ffmpeg: writes `pieces` files per feed as soon as it is spawned (the last one still "in progress"). */
function fakeFfmpeg({ pieces = 4, exitCode = null } = {}) {
  const calls = []
  const spawnFn = (exe, args) => {
    const child = new EventEmitter()
    child.pid = 4000 + calls.length
    child.stderr = new EventEmitter()
    child.kill = () => { child.killed = true }
    const start = Number(args[args.indexOf('-segment_start_number') + 1])
    const outs = args.filter((a) => /-%d\.wav$/.test(a))
    const call = { exe, args, start, feeds: outs.map((o) => path.basename(o).split('-')[0]), child, seek: args.includes('-ss') ? Number(args[args.indexOf('-ss') + 1]) : 0 }
    calls.push(call)
    call.write = (upto) => { for (let i = start; i <= upto; i++) for (const o of outs) { try { fs.writeFileSync(o.replace('%d', String(i)), Buffer.alloc(64, i)) } catch { /* the folder was cleaned up meanwhile */ } } }
    call.finish = (code = 0) => { child.emit('exit', code); child.emit('close', code) }
    setImmediate(() => {
      call.write(start + pieces)
      if (exitCode !== null) { call.stderr = null; child.stderr.emit('data', 'C:\\film.mkv: Invalid data found when processing input'); call.finish(exitCode) }
    })
    return child
  }
  return { calls, spawnFn }
}

function make(opts = {}) {
  const root = fx.tmpDir('beebo-spk-audio-')
  const f = fakeFfmpeg(opts.ffmpeg)
  const clock = { t: 1_000_000 }
  const priorities = []
  const m = audio.createAudioManager({
    ffmpegPath: 'ffmpeg', tmpRoot: root, spawnFn: f.spawnFn, now: () => clock.t, pollMs: 2, waitTimeoutMs: 1500, sweepEveryMs: 0,
    setPriority: (pid, level) => priorities.push([pid, level]), profile: opts.profile || null, overrides: opts.overrides || {}, ...(opts.manager || {})
  })
  const open = (key = 'film1', feeds = ['FL', 'DM'], dur = 600) => m.open({ key, filePath: 'C:\\movies\\film.mkv', source, durationSec: dur, feeds })
  return { m, root, f, clock, priorities, open }
}

test('a first request starts one run at piece 0 for every feed; normal priority at first, below-normal once the phones have two pieces', async () => {
  const { m, f, open, priorities } = make()
  const s = open()
  const file = await m.segment(s, 'FL', 0)
  assert.ok(fs.existsSync(file) && /FL-0\.wav$/.test(file))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].feeds.sort(), ['DM', 'FL'])
  assert.equal(f.calls[0].seek, 0)
  assert.deepEqual(priorities, [[4000, 'normal'], [4000, 'low']])
  // the other feed is there too, and the second piece needs no new run
  assert.ok(fs.existsSync(await m.segment(s, 'DM', 1)))
  assert.equal(f.calls.length, 1)
  m.closeAll()
})

test('a request far from the run is a seek: ffmpeg restarts right there, and stale pieces after it are rewritten', async () => {
  const { m, f, open } = make()
  const s = open()
  await m.segment(s, 'FL', 0)
  const far = await m.segment(s, 'FL', 20)
  assert.match(far, /FL-20\.wav$/)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].start, 20)
  assert.equal(f.calls[1].seek, 100) // 20 pieces x 5 s
  assert.ok(f.calls[0].child.killed, 'the old run was stopped')
  // pieces from before the seek are kept (rewinding is free)
  assert.ok(fs.existsSync(path.join(s.dir, 'FL-0.wav')))
  m.closeAll()
})

test('a piece just ahead of the run is waited for, not a restart', async () => {
  const { m, f, open } = make()
  const s = open()
  await m.segment(s, 'FL', 0) // pieces 0-3 complete, 4 in progress
  const p = m.segment(s, 'FL', 4)
  setTimeout(() => f.calls[0].write(8), 20)
  assert.match(await p, /FL-4\.wav$/)
  assert.equal(f.calls.length, 1)
  m.closeAll()
})

test('asking for a feed nobody cut yet restarts the run with every feed, keeping the position', async () => {
  const { m, f, open } = make()
  const s = open('film1', ['FL'])
  await m.segment(s, 'FL', 2)
  assert.deepEqual(f.calls[0].feeds, ['FL'])
  const file = await m.segment(s, 'SR', 2)
  assert.match(file, /SR-2\.wav$/)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].feeds.sort(), ['FL', 'SR'])
  assert.equal(f.calls[1].start, 2)
  // ensureFeeds only records the wish
  m.ensureFeeds(s, ['LFE', 'nonsense'])
  assert.ok(s.feeds.has('LFE') && !s.feeds.has('nonsense'))
  m.closeAll()
})

test('a run that raced far ahead is stopped, and started again where it stopped when the phones catch up', async () => {
  const { m, f, open } = make({ ffmpeg: { pieces: 20 }, overrides: { maxAheadSegments: 8 } })
  const s = open()
  await m.segment(s, 'FL', 0)
  assert.ok(f.calls[0].child.killed, 'stopped: 19 pieces ahead of the phones is more than 8')
  assert.equal(s.proc, null)
  // pieces 0..19 are there; phones move on to 15: a run continues from the first missing piece (20)
  assert.match(await m.segment(s, 'FL', 15), /FL-15\.wav$/) // already there, and near enough to the end of what exists to wake the run up
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].start, 20, 'continues from the first missing piece')
  assert.match(await m.segment(s, 'FL', 21), /FL-21\.wav$/)
  assert.equal(f.calls.length, 2, 'the resumed run already covers 21')
  m.closeAll()
})

test('pieces far behind the phones are pruned', async () => {
  const { m, open } = make({ ffmpeg: { pieces: 30 }, overrides: { keepBehindSegments: 4, maxAheadSegments: 100 } })
  const s = open()
  await m.segment(s, 'FL', 0)
  await m.segment(s, 'FL', 20)
  const names = fs.readdirSync(s.dir)
  assert.ok(!names.includes('FL-5.wav') && names.includes('FL-16.wav') && names.includes('FL-20.wav'), names.join())
  m.closeAll()
})

test('a phone that hangs up ends its own wait; hostile piece numbers and feeds are refused', async () => {
  const { m, open } = make({ ffmpeg: { pieces: 1 } })
  const s = open()
  await m.segment(s, 'FL', 0)
  let hangup = false
  const p = m.segment(s, 'FL', 3, { aborted: () => hangup })
  setTimeout(() => { hangup = true }, 20)
  assert.equal(await p, null)
  for (const [feed, n] of [['ZZ', 0], ['FL', -1], ['FL', 1.5], ['FL', 'x'], ['FL', 10 ** 9], ['../FL', 0]]) assert.equal(await m.segment(s, feed, n), null, `${feed} ${n}`)
  m.closeAll()
})

test('a run that dies reports the reason (paths hidden) and is retried after a pause', async () => {
  const { m, f, open, clock } = make({ ffmpeg: { pieces: 0, exitCode: 1 } })
  const s = open()
  await assert.rejects(() => m.segment(s, 'FL', 0), /ffmpeg stopped \(1\).*\[path\]/)
  assert.doesNotMatch(s.error, /C:\\film/)
  await assert.rejects(() => m.segment(s, 'FL', 0), /ffmpeg stopped/) // not retried at once
  assert.equal(f.calls.length, 1)
  clock.t += 11000
  await assert.rejects(() => m.segment(s, 'FL', 0), /ffmpeg stopped/)
  assert.equal(f.calls.length, 2, 'retried after the pause')
  m.closeAll()
})

test('a run that hangs (no output at all) is killed and started again, then given up on: it never spins forever', async () => {
  const { m, f, open } = make({ ffmpeg: { pieces: -1 }, manager: { now: Date.now, stallMs: 60, waitTimeoutMs: 5000 } })
  const s = open()
  await assert.rejects(() => m.segment(s, 'FL', 0), /kept stalling/)
  assert.equal(f.calls.length, 3, 'started three times')
  assert.ok(f.calls.every((c) => c.child.killed), 'and every hung run was killed')
  assert.equal(s.proc, null)
  m.closeAll()
})

test('a missing ffmpeg and a film with no audio are clear errors', async () => {
  const root = fx.tmpDir()
  const m = audio.createAudioManager({ ffmpegPath: () => null, tmpRoot: root, sweepEveryMs: 0, pollMs: 2 })
  const s = m.open({ key: 'k', filePath: 'x.mkv', source, durationSec: 60, feeds: ['FL'] })
  await assert.rejects(() => m.segment(s, 'FL', 0), /not installed/)
  assert.throws(() => m.open({ key: 'k2', filePath: 'x.mkv', source: { ...source, streamIndex: null }, durationSec: 60, feeds: ['FL'] }), /no_audio/)
  assert.throws(() => m.open({ key: 'k3', filePath: 'x.mkv', source, durationSec: 0, feeds: ['FL'] }), /unknown_duration/)
  assert.throws(() => m.open({ key: 'k4', filePath: 'x.mkv', source, durationSec: 60, feeds: [] }), /no feeds/)
  m.closeAll()
})

test('old-PC rules: one film at a time, a short look-ahead, one decode thread; busy is an error until an idle film makes way', async () => {
  const low = { tier: 'low', cores: 2, filterThreads: 1 }
  const { m, f, open, clock } = make({ profile: low })
  assert.deepEqual(m.limits(), { maxSessions: 1, maxAheadSegments: 12, keepBehindSegments: 6, maxCacheBytes: 256 * 1024 * 1024 })
  const s = open('a')
  await m.segment(s, 'FL', 0)
  assert.ok(f.calls[0].args.includes('-threads'), 'decoding on one thread')
  assert.throws(() => open('b'), (e) => e instanceof audio.BusyError && /busy/.test(e.message))
  clock.t += 31000 // film a has not been asked about for 30 s: it makes way
  const s2 = open('b')
  assert.ok(s2 && !m.get('a'))
  assert.equal(audio.limitsFor({ tier: 'high' }).maxSessions, 3)
  assert.equal(audio.limitsFor(null).maxSessions, 2)
  m.closeAll()
  // the owner's own limit (Settings) wins
  const owner = audio.createAudioManager({ ffmpegPath: 'x', tmpRoot: fx.tmpDir(), sweepEveryMs: 0, profile: low, maxConcurrent: () => 3 })
  assert.equal(owner.limits().maxSessions, 3)
  owner.closeAll()
})

test('cleanup is least-recently-used: idle stops ffmpeg, retention forgets the film, the size limit evicts the oldest', async () => {
  const { m, f, open, clock } = make({ ffmpeg: { pieces: 3 }, overrides: { maxSessions: 4 } })
  const a = open('a'); await m.segment(a, 'FL', 0)
  clock.t += 60000
  const b = open('b'); await m.segment(b, 'FL', 0)
  clock.t += 100000 // a idle 160 s, b idle 100 s: nothing yet
  m.sweep()
  assert.ok(a.proc && b.proc)
  clock.t += 30000 // a idle 190 s > 3 min: its ffmpeg stops, its pieces stay
  m.sweep()
  assert.equal(a.proc, null); assert.ok(b.proc); assert.ok(fs.existsSync(path.join(a.dir, 'FL-0.wav')))
  assert.ok(f.calls[0].child.killed)
  // the same film asked for again finds its cached pieces at once, and the run carries on from where it stopped
  const runsBefore = f.calls.length
  assert.match(await m.segment(a, 'FL', 1), /FL-1\.wav$/)
  assert.equal(f.calls.length, runsBefore + 1)
  assert.equal(f.calls[runsBefore].start, 3)
  clock.t += 31 * 60 * 1000 // long retention: both forgotten, folders deleted
  m.sweep()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(m.size(), 0)
  assert.ok(!fs.existsSync(a.dir))
  m.closeAll()
  // the size limit: the film asked for longest ago goes first
  const capped = make({ ffmpeg: { pieces: 3 }, overrides: { maxSessions: 4, maxCacheBytes: 500 } })
  const x = capped.open('x'); await capped.m.segment(x, 'FL', 0)
  capped.clock.t += 5000
  const y = capped.open('y'); await capped.m.segment(y, 'FL', 0)
  const r = capped.m.sweep()
  assert.ok(r.evicted >= 1); assert.ok(!capped.m.get('x') && capped.m.get('y'))
  capped.m.closeAll()
})

test('leftovers from a previous run of the app are deleted when the manager starts', () => {
  const root = fx.tmpDir()
  fs.mkdirSync(path.join(root, 'old'), { recursive: true }); fs.writeFileSync(path.join(root, 'old', 'FL-0.wav'), 'x')
  const m = audio.createAudioManager({ ffmpegPath: 'x', tmpRoot: root, sweepEveryMs: 0 })
  assert.ok(!fs.existsSync(path.join(root, 'old')))
  m.closeAll()
})

// ------------------------------------------------------------------ the real thing
const skip = fx.FFMPEG ? false : 'ffmpeg not found (set BEEBO_FFMPEG)'

test('real ffmpeg: pieces are served for a 5.1 film, in order, after a seek, and with a new feed added', { skip }, async () => {
  const dir0 = fx.tmpDir()
  const film = fx.makeTone51(path.join(dir0, 'film.mka'), 30)
  const src = ch.describeSource({ channels: 6, channelLayout: '5.1(side)', streamIndex: 0 })
  const m = audio.createAudioManager({ ffmpegPath: () => fx.FFMPEG, tmpRoot: path.join(dir0, 'cache'), sweepEveryMs: 0, profile: null })
  const s = m.open({ key: 'real1', filePath: film, source: src, durationSec: 30, feeds: ['FL', 'FC'] })
  const level = (feed, n, freq) => { const w = fx.readWav(path.join(s.dir, `${feed}-${n}.wav`)); return fx.db(fx.tonePower(w.samples, w.rate, freq, 2000)) - fx.db(0.125 * 0.125) }
  const p0 = await m.segment(s, 'FL', 0)
  assert.ok(Math.abs(level('FL', 0, fx.TONES.FL)) < 0.5)
  await m.segment(s, 'FC', 0)
  assert.ok(Math.abs(level('FC', 0, fx.TONES.FC)) < 0.5 && level('FC', 0, fx.TONES.FL) < -60)
  // a seek to 25 s (piece 5) and then the last piece
  await m.segment(s, 'FL', 5)
  assert.ok(Math.abs(level('FL', 5, fx.TONES.FL)) < 0.5)
  assert.ok(s.runStart === 5 || s.runStart === 0)
  // a phone that becomes the sub asks for LFE: cut from here on
  const lfe = await m.segment(s, 'LFE', 5)
  assert.match(lfe, /LFE-5\.wav$/)
  assert.ok(Math.abs(level('LFE', 5, fx.TONES.LFE)) < 1)
  // past the end
  assert.equal(await m.segment(s, 'FL', 6), fs.existsSync(path.join(s.dir, 'FL-6.wav')) ? path.join(s.dir, 'FL-6.wav') : null)
  assert.equal(await m.segment(s, 'FL', 7), null)
  assert.ok(p0.endsWith('FL-0.wav'))
  m.closeAll()
})
