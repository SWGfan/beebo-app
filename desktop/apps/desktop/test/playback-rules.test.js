const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

const rules = localRequire('./electron/playbackRules')
const convert = localRequire('./electron/convert')
const scan = localRequire('./electron/playabilityScan')

function fakeStore(initial = {}) {
  const m = new Map(Object.entries(initial))
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }
}

// A probe shaped like normalizeProbe's output.
function P({ format = 'matroska,webm', v = 'h264', profile = 'High', level = 41, pix = 'yuv420p', audio = ['aac'], subs = [], dur = 2700 } = {}) {
  return rules.normalizeProbe({
    format: { format_name: format, duration: String(dur) },
    streams: [
      ...(v ? [{ index: 0, codec_type: 'video', codec_name: v, profile, level, pix_fmt: pix }] : []),
      ...audio.map((a, i) => ({ index: 1 + i, codec_type: 'audio', codec_name: a, channels: 6 })),
      ...subs.map((s, i) => ({ index: 1 + audio.length + i, codec_type: 'subtitle', codec_name: s }))
    ]
  })
}
const FORMAT = { '.mkv': 'matroska,webm', '.webm': 'matroska,webm', '.mp4': 'mov,mp4,m4a,3gp,3g2,mj2', '.mov': 'mov,mp4,m4a,3gp,3g2,mj2', '.avi': 'avi', '.wmv': 'asf', '.ts': 'mpegts' }
const act = (ext, o) => rules.decide(P({ format: FORMAT[ext], ...o }), ext).action

// ------------------------------------------------------------------ regressions
test('regression: MKV + H.264 + AAC plays as it is', () => {
  assert.equal(act('.mkv', { v: 'h264', audio: ['aac'] }), 'none')
})
test('regression: MKV + HEVC 8-bit + AC3 plays as it is (documented: HEVC Main and AC-3 are fine)', () => {
  assert.equal(act('.mkv', { v: 'hevc', profile: 'Main', level: 120, audio: ['ac3'] }), 'none')
})
test('regression: AVI + H.264 is a remux', () => {
  const d = rules.decide(P({ format: 'avi', audio: ['mp3'] }), '.avi')
  assert.equal(d.action, 'remux')
  assert.match(d.reason, /AVI container.*fast remux, about \d+ minute/)
})
test('regression: MKV + H.264 + DTS is audio-only', () => {
  const d = rules.decide(P({ audio: ['dts'] }), '.mkv')
  assert.equal(d.action, 'audio')
  assert.match(d.reason, /^Audio is DTS, which phones can't play: fast audio fix, about \d+ minutes?$/)
})
test('regression: AVI + Xvid is a full re-encode', () => {
  const d = rules.decide(P({ format: 'avi', v: 'mpeg4', profile: 'Advanced Simple Profile', level: 5, audio: ['mp3'] }), '.avi')
  assert.equal(d.action, 'video')
  assert.match(d.reason, /MPEG-4 Part 2.*full re-encode/)
})

// ------------------------------------------------------------------ the matrix
test('matrix: containers x video codecs x profiles x bit depths x audio x subtitles', () => {
  const videos = [
    // [codec, profile, level, pix, expected video verdict ('ok' | 'bad')]
    ['h264', 'Constrained Baseline', 30, 'yuv420p', 'ok'],
    ['h264', 'Main', 40, 'yuv420p', 'ok'],
    ['h264', 'High', 51, 'yuv420p', 'ok'],
    ['h264', 'High', 52, 'yuv420p', 'bad'],
    ['h264', 'High 10', 41, 'yuv420p10le', 'bad'],
    ['h264', 'High 4:2:2', 41, 'yuv422p', 'bad'],
    ['h264', 'High 4:4:4 Predictive', 41, 'yuv444p', 'bad'],
    ['hevc', 'Main', 150, 'yuv420p', 'ok'],
    ['hevc', 'Main 10', 153, 'yuv420p10le', 'ok'],
    ['hevc', 'Rext', 153, 'yuv422p10le', 'bad'],
    ['vp9', 'Profile 0', null, 'yuv420p', 'ok'],
    ['vp9', 'Profile 2', null, 'yuv420p10le', 'ok'],
    ['av1', 'Main', null, 'yuv420p10le', 'ok'],
    ['mpeg2video', 'Main', 8, 'yuv420p', 'bad'],
    ['mpeg4', 'Advanced Simple Profile', 5, 'yuv420p', 'bad'],
    ['msmpeg4v3', null, null, 'yuv420p', 'bad'],
    ['vc1', 'Advanced', 3, 'yuv420p', 'bad'],
    ['wmv3', 'Main', null, 'yuv420p', 'bad']
  ]
  const audios = [
    ['aac', 'ok'], ['mp3', 'ok'], ['opus', 'ok'], ['vorbis', 'ok'], ['flac', 'ok'], ['ac3', 'ok'], ['eac3', 'ok'],
    ['dts', 'bad'], ['truehd', 'bad'], ['mp2', 'bad'], ['wmav2', 'bad'], ['pcm_s24le', 'bad']
  ]
  const containers = [['.mkv', 'ok'], ['.mp4', 'ok'], ['.mov', 'ok'], ['.webm', 'ok'], ['.ts', 'ok'], ['.avi', 'bad'], ['.wmv', 'bad']]
  const subtitleSets = [[], ['subrip'], ['hdmv_pgs_subtitle'], ['dvd_subtitle', 'ass']]
  let n = 0
  for (const [ext, cOk] of containers) {
    for (const [v, profile, level, pix, vOk] of videos) {
      for (const [a, aOk] of audios) {
        for (const subs of subtitleSets) {
          const want = vOk === 'bad' ? 'video' : aOk === 'bad' ? 'audio' : cOk === 'bad' ? 'remux' : 'none'
          const got = rules.decide(P({ format: FORMAT[ext], v, profile, level, pix, audio: [a], subs }), ext)
          assert.equal(got.action, want, `${ext} ${v} ${profile} ${pix} ${a} subs=${subs.join('+')}`)
          n++
        }
      }
    }
  }
  assert.equal(n, 7 * 18 * 12 * 4)
})

test('several audio tracks: fine when any one plays; strict mode needs AAC/MP3', () => {
  assert.equal(act('.mkv', { audio: ['dts', 'ac3'] }), 'none')
  assert.equal(act('.mkv', { audio: ['truehd', 'dts'] }), 'audio')
  assert.equal(rules.decide(P({ audio: ['ac3'] }), '.mkv', { strict: true }).action, 'audio')
  assert.equal(rules.decide(P({ format: FORMAT['.mp4'], audio: ['aac'] }), '.mp4', { strict: true }).action, 'none')
  assert.equal(rules.decide(P({ v: 'hevc', profile: 'Main', level: 120 }), '.mkv', { strict: true }).action, 'video')
  assert.equal(rules.decide(P({ level: 50 }), '.mkv', { strict: true }).action, 'video')
})

test('no probe is "unknown" (never auto-queued); no video stream is "none"; cover art is not the video', () => {
  assert.equal(rules.decide(null, '.mkv').action, 'unknown')
  assert.equal(rules.needsWork(rules.decide(null, '.avi')), false)
  assert.equal(act('.mkv', { v: null, audio: ['dts'] }), 'none')
  const withCover = rules.normalizeProbe({ format: { format_name: 'matroska,webm', duration: '60' }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, pix_fmt: 'yuv420p' },
    { index: 2, codec_type: 'audio', codec_name: 'aac' }
  ] })
  assert.equal(rules.decide(withCover, '.mkv').action, 'none')
})

test('a legacy cached probe (flat fields only) still gets a stream-based answer', () => {
  assert.equal(rules.decide({ videoCodec: 'h264', audioCodec: 'aac', videoLevel: 40, videoPixFmt: 'yuv420p', hasAudio: true, durationSec: 60 }, '.mkv').action, 'none')
  assert.equal(rules.decide({ videoCodec: 'mpeg4', audioCodec: 'mp3', hasAudio: true, durationSec: 60 }, '.avi').action, 'video')
})

test('planArgs: remux copies, audio fix keeps DTS as a second track, re-encode copies playable audio', () => {
  const remux = rules.planArgs(rules.decide(P({ format: 'avi', audio: ['mp3'] }), '.avi'), P({ format: 'avi', audio: ['mp3'] }))
  assert.equal(remux.mode, 'remux')
  assert.ok(remux.args.join(' ').includes('-c:v copy -c:a copy'))

  const dtsProbe = P({ audio: ['dts'], subs: ['subrip', 'hdmv_pgs_subtitle'] })
  const audio = rules.planArgs(rules.decide(dtsProbe, '.mkv'), dtsProbe)
  assert.equal(audio.mode, 'audio-only')
  const s = audio.args.join(' ')
  assert.ok(s.includes('-map 0:1 -map 0:1'), s)
  assert.ok(s.includes('-c:a:0 aac') && s.includes('-c:a:1 copy'), s)
  assert.ok(s.includes('-map 0:2 -c:s mov_text'), 'text subtitles kept')
  assert.ok(!s.includes('0:3'), 'image subtitles are not mapped into MP4')

  const truehd = P({ audio: ['truehd'] })
  assert.ok(!rules.planArgs(rules.decide(truehd, '.mkv'), truehd).args.includes('-c:a:1'), 'TrueHD is not kept in MP4')

  const xvid = P({ format: 'avi', v: 'mpeg4', audio: ['mp3'] })
  const full = rules.planArgs(rules.decide(xvid, '.avi'), xvid)
  assert.equal(full.mode, 'full')
  assert.ok(full.args.join(' ').includes('-c:v libopenh264') && full.args.join(' ').includes('-c:a copy'))
})

// ------------------------------------------------------------------ evidence
const history = (fileName, currentTime, duration = 2700) => ({ sessionId: String(Math.random()), fileName, currentTime, duration, startedAt: 1, lastUpdate: 2 })

test('known-good: over 5 minutes, or 20% of a short file, on a folder boundary', () => {
  const idx = rules.playedSessionsIndex([
    history('Show\\Show S01E01.mkv', 301),
    history('Short.mkv', 130, 600),
    history('Barely.mkv', 120),
    history('Other S01E02.mkv', 900)
  ])
  assert.ok(rules.knownGoodFor(idx, path.resolve('/lib/TV/Show/Show S01E01.mkv')))
  assert.ok(rules.knownGoodFor(idx, path.resolve('/lib/Movies/Short.mkv')))
  assert.equal(rules.knownGoodFor(idx, path.resolve('/lib/Movies/Barely.mkv')), null)
  assert.equal(rules.knownGoodFor(idx, path.resolve('/lib/TV/Another S01E02.mkv')), null, 'not a suffix match mid-name')
})

test('planJob: known-good files are parked, device failures and Convert anyway are strict', () => {
  const src = path.resolve('/lib/Movies/Old Film.avi')
  const store = fakeStore({ watchHistory: [history('Old Film.avi', 1200)] })
  const xvid = P({ format: 'avi', v: 'mpeg4', audio: ['mp3'] })
  const parked = convert.planJob(store, { originalPath: src }, xvid)
  assert.equal(parked.parkAs, 'not-needed')
  assert.match(parked.skip, /already played fine/)
  assert.equal(convert.planJob(store, { originalPath: src, deviceFailure: true }, xvid).mode, 'full')
  const fine = P({ format: FORMAT['.mp4'] })
  assert.equal(convert.planJob(fakeStore(), { originalPath: path.resolve('/lib/a.mp4') }, fine).parkAs, 'not-needed')
  assert.equal(convert.planJob(fakeStore(), { originalPath: path.resolve('/lib/a.mp4'), force: true }, fine).mode, 'remux')
  assert.equal(convert.planJob(fakeStore(), { originalPath: path.resolve('/lib/a.mkv'), force: true }, P({ audio: ['ac3'] })).mode, 'audio-only')
})

test('overrides: Don\'t convert blocks automatic and device re-queues; Convert anyway brings it back', () => {
  const store = fakeStore()
  const p = path.resolve('/lib/x.avi')
  const q = convert.enqueue(store, { path: p, kind: 'movie' })
  assert.equal(convert.dontConvert(store, q.id).ok, true)
  assert.equal(store.get('conversions')[0].status, 'dont-convert')
  assert.equal(convert.enqueue(store, { path: p, kind: 'movie' }).error, 'dont_convert')
  assert.equal(convert.enqueue(store, { path: p, kind: 'movie', deviceFailure: true }).error, 'dont_convert')
  assert.equal(convert.pickNext(store.get('conversions')), null)
  const r = convert.convertAnyway(store, q.id)
  assert.equal(r.ok, true)
  const e = store.get('conversions')[0]
  assert.equal(e.status, 'queued')
  assert.equal(e.force, true)
  assert.equal(convert.dontConvert(store, 'nope').error, 'not_found')
})

test('a not-needed file stays parked for automatic sources, but a device failure re-queues it first in line', () => {
  const store = fakeStore()
  const a = convert.enqueue(store, { path: path.resolve('/lib/a.mkv'), kind: 'movie' })
  const b = convert.enqueue(store, { path: path.resolve('/lib/b.avi'), kind: 'movie' })
  store.set('conversions', store.get('conversions').map((e) => (e.id === a.id ? { ...e, status: 'not-needed' } : e)))
  assert.equal(convert.enqueue(store, { path: path.resolve('/lib/a.mkv'), kind: 'movie' }).notNeeded, true)
  const again = convert.enqueue(store, { path: path.resolve('/lib/a.mkv'), kind: 'movie', deviceFailure: true })
  assert.equal(again.requeued, true)
  assert.equal(convert.pickNext(store.get('conversions')).id, a.id, 'device failure beats an earlier queued entry')
  assert.ok(b.ok)
})

test('upgrade: the waiting queue is re-checked once; finished and explicit entries are untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-rules-reeval-'))
  try {
    const mk = (n) => { const p = path.join(dir, n); fs.writeFileSync(p, 'x'); return p }
    const files = { h264mkv: mk('Fine.mkv'), ac3mkv: mk('Dolby.mkv'), xvid: mk('Xvid.avi'), watched: mk('Watched.avi'), dts: mk('Dts.mkv'), done: mk('Done.mkv'), failed: mk('Failed.mp4'), broken: mk('Broken.mkv') }
    const probes = {
      [files.h264mkv]: P(), [files.ac3mkv]: P({ audio: ['ac3'] }), [files.xvid]: P({ format: 'avi', v: 'mpeg4', audio: ['mp3'] }),
      [files.watched]: P({ format: 'avi', v: 'mpeg4', audio: ['mp3'] }), [files.dts]: P({ audio: ['dts'] }),
      [files.done]: P(), [files.failed]: P({ format: FORMAT['.mp4'] }), [files.broken]: null
    }
    const probed = []
    const probe = async (p) => { probed.push(p); return probes[p] }
    const e = (id, p, over = {}) => ({ id: `178900000000${id}-abc`, originalPath: p, outputPath: p + '.mp4', status: 'queued', kind: 'movie', queuedAt: 1789000000000 + id, ...over })
    const store = fakeStore({
      conversions: [
        e(1, files.h264mkv), e(2, files.ac3mkv), e(3, files.xvid), e(4, files.watched), e(5, files.dts),
        e(6, files.done, { status: 'done' }), e(7, files.failed, { deviceFailure: true }), e(8, files.broken),
        e(9, path.join(dir, 'Missing.mkv'))
      ],
      watchHistory: [history('Watched.avi', 2000)]
    })
    const r = await convert.reevaluateQueue(store, { probe })
    assert.equal(r.ran, true)
    const by = Object.fromEntries(store.get('conversions').map((x) => [path.basename(x.originalPath), x]))
    assert.equal(by['Fine.mkv'].status, 'not-needed')
    assert.equal(by['Dolby.mkv'].status, 'not-needed')
    assert.equal(by['Watched.avi'].status, 'not-needed')
    assert.match(by['Watched.avi'].notNeededReason, /Already played fine/)
    assert.equal(by['Xvid.avi'].status, 'queued')
    assert.equal(by['Xvid.avi'].plan.work, 'full re-encode')
    assert.equal(by['Dts.mkv'].status, 'queued')
    assert.match(by['Dts.mkv'].plan.reason, /Audio is DTS/)
    assert.equal(by['Done.mkv'].status, 'done')
    assert.equal(by['Failed.mp4'].status, 'queued', 'a device-reported failure is never removed')
    assert.equal(by['Broken.mkv'].status, 'queued', 'unreadable files are not removed by guesswork')
    assert.equal(by['Missing.mkv'].status, 'queued')
    assert.ok(!probed.includes(files.done) && !probed.includes(files.failed))
    const summary = store.get(convert.RULES_SUMMARY_KEY)
    assert.equal(summary.removed, 3)
    assert.equal(summary.playedFine, 1)
    assert.equal(summary.dismissed, false)
    // Once per rules version.
    assert.equal((await convert.reevaluateQueue(store, { probe })).ran, false)
    convert.dismissRulesSummary(store)
    assert.equal(store.get(convert.RULES_SUMMARY_KEY).dismissed, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the library scan queues only files that need work, with their decision', async () => {
  const probes = { '/l/a.mkv': P(), '/l/b.avi': P({ format: 'avi', v: 'mpeg4' }), '/l/c.mkv': P({ audio: ['dts'] }), '/l/d.mkv': null }
  const s = scan.createUnplayableScanner({ probe: async (p) => probes[p], decide: (pr, ext) => convert.decideFor(pr, ext), stat: async () => ({ size: 1, mtimeMs: 1 }) })
  const got = []
  const r = s.start({ listFiles: async () => Object.keys(probes).map((p) => ({ path: p, kind: 'movie' })), onNeeds: (f, d) => { got.push([f.path, d.action]); return true } })
  await r.done
  assert.deepEqual(got, [['/l/b.avi', 'video'], ['/l/c.mkv', 'audio']])
  assert.equal(s.status().skippedByExtension, 0)
})

// ------------------------------------------------------------------ real ffmpeg
test('real files: probe + decide + convert with the real ffmpeg', async (t) => {
  const ffmpeg = process.env.BEEBO_FFMPEG
  if (!ffmpeg || !fs.existsSync(ffmpeg) || !process.env.BEEBO_FFPROBE) { t.skip('set BEEBO_FFMPEG and BEEBO_FFPROBE to run'); return }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-rules-real-'))
  try {
    const V = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2']
    const A = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=48000']
    const make = (name, args) => { execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...V, ...A, ...args, path.join(dir, name)]); return path.join(dir, name) }
    const files = {
      'h264-aac.mkv': make('h264-aac.mkv', ['-c:v', 'libopenh264', '-c:a', 'aac']),
      'h264-ac3.mkv': make('h264-ac3.mkv', ['-c:v', 'libopenh264', '-c:a', 'ac3']),
      'h264-dts.mkv': make('h264-dts.mkv', ['-c:v', 'libopenh264', '-c:a', 'dca', '-strict', '-2', '-ac', '2']),
      'h264-mp3.avi': make('h264-mp3.avi', ['-c:v', 'libopenh264', '-c:a', 'libmp3lame']),
      'xvid-mp3.avi': make('xvid-mp3.avi', ['-c:v', 'mpeg4', '-c:a', 'libmp3lame'])
    }
    const want = { 'h264-aac.mkv': 'none', 'h264-ac3.mkv': 'none', 'h264-dts.mkv': 'audio', 'h264-mp3.avi': 'remux', 'xvid-mp3.avi': 'video' }
    const probes = {}
    for (const [name, p] of Object.entries(files)) {
      probes[name] = await convert.probeStreams(p)
      assert.equal(convert.decideFor(probes[name], path.extname(p)).action, want[name], name)
    }
    // Run the three real jobs through the converter itself.
    const store = fakeStore()
    for (const name of ['h264-dts.mkv', 'h264-mp3.avi', 'xvid-mp3.avi', 'h264-aac.mkv']) convert.enqueue(store, { path: files[name], kind: 'movie' })
    for (const entry of store.get('conversions').slice()) await convert.runOne(store, entry)
    const by = Object.fromEntries(store.get('conversions').map((x) => [path.basename(x.originalPath), x]))
    assert.equal(by['h264-aac.mkv'].status, 'not-needed', 'a playable MKV is never converted')
    for (const name of ['h264-dts.mkv', 'h264-mp3.avi', 'xvid-mp3.avi']) assert.equal(by[name].status, 'done', `${name}: ${by[name].error}`)
    const out = (name) => convert.probeStreams(by[name].outputPath)
    const dtsOut = await out('h264-dts.mkv')
    assert.deepEqual(dtsOut.audios.map((a) => a.codec), ['aac', 'dts'], 'AAC first, original DTS kept')
    assert.equal(dtsOut.videoCodec, 'h264')
    const remuxOut = await out('h264-mp3.avi')
    assert.deepEqual([remuxOut.videoCodec, remuxOut.audioCodec], ['h264', 'mp3'])
    assert.equal(convert.decideFor(remuxOut, '.mp4').action, 'none')
    const xvidOut = await out('xvid-mp3.avi')
    assert.equal(xvidOut.videoCodec, 'h264')
    assert.equal(convert.decideFor(xvidOut, '.mp4').action, 'none')
    // Originals untouched.
    for (const p of Object.values(files)) assert.ok(fs.existsSync(p))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
