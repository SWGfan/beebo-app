// Speech Pack, the pure parts: whisper JSON -> SRT formatting, the argument lists handed to whisper/ffmpeg
// (no shell, validated values only), language detection parsing, and the "AI-generated" naming and label.
// Run: node --test test/speech-pack-srt.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const F = require('./helpers/addonFixtures')
const { localRequire } = F
const srt = localRequire('./electron/addons/speechPack/srt')
const whisper = localRequire('./electron/addons/speechPack/whisper')
const ai = localRequire('./electron/aiSubtitles')
const mediaInfo = localRequire('./electron/mediaInfo')

// ------------------------------------------------------------------------ srt
test('formatTimestamp: HH:MM:SS,mmm with rounding and clamping', () => {
  assert.equal(srt.formatTimestamp(0), '00:00:00,000')
  assert.equal(srt.formatTimestamp(1.5), '00:00:01,500')
  assert.equal(srt.formatTimestamp(61.0004), '00:01:01,000')
  assert.equal(srt.formatTimestamp(3661.999), '01:01:01,999')
  assert.equal(srt.formatTimestamp(7200), '02:00:00,000')
  assert.equal(srt.formatTimestamp(-4), '00:00:00,000')
  assert.equal(srt.formatTimestamp(NaN), '00:00:00,000')
})

test('parseWhisperJson reads offsets (ms) and the detected language; rejects anything else', () => {
  const text = JSON.stringify({ result: { language: 'FR' }, transcription: [
    { timestamps: { from: 'x', to: 'y' }, offsets: { from: 1000, to: 2500 }, text: ' Bonjour.' },
    { offsets: { from: 'bad' }, text: 'skipped' },
    { offsets: { from: 3000, to: 2000 }, text: ' reversed' }
  ] })
  const p = srt.parseWhisperJson('\uFEFF' + text)
  assert.equal(p.language, 'fr')
  assert.deepEqual(p.segments, [{ start: 1, end: 2.5, text: ' Bonjour.' }, { start: 3, end: 3, text: ' reversed' }])
  assert.equal(srt.parseWhisperJson('not json'), null)
  assert.equal(srt.parseWhisperJson('{"a":1}'), null)
})

test('formatting: exact SRT text, numbering, blank lines between cues', () => {
  const out = srt.segmentsToSrt([
    { start: 1, end: 3.5, text: ' Hello there.' },
    { start: 4, end: 6, text: ' General Kenobi!' }
  ])
  assert.equal(out, '1\n00:00:01,000 --> 00:00:03,500\nHello there.\n\n2\n00:00:04,000 --> 00:00:06,000\nGeneral Kenobi!\n')
})

test('cleaning: blanks, sound tags, punctuation-only lines and endless repeats are dropped; overlaps fixed; order restored', () => {
  const segs = [
    { start: 10, end: 12, text: ' Real line.' },
    { start: 0, end: 1, text: ' [BLANK_AUDIO]' },
    { start: 1, end: 2, text: ' (music)' },
    { start: 2, end: 3, text: ' ♪♪ ' },
    { start: 3, end: 4, text: '   ' },
    { start: 5, end: 6, text: ' Thank you.' }, { start: 6, end: 7, text: ' Thank you.' }, { start: 7, end: 8, text: ' Thank you.' }, { start: 8, end: 9, text: ' Thank you.' },
    { start: 11, end: 15, text: ' Overlapping.' },
    { start: 20, end: 20, text: ' Tiny.' },
    { start: 30, end: 31, text: ' Bad --> arrow \uFFFD' }
  ]
  const c = srt.cleanSegments(segs)
  assert.deepEqual(c.map((s) => s.text), ['Thank you.', 'Thank you.', 'Real line.', 'Overlapping.', 'Tiny.', 'Bad -> arrow'])
  assert.ok(c[2].end <= c[3].start, 'no overlap with the next cue')
  assert.ok(c[4].end - c[4].start >= 0.6, 'a zero-length cue is given a readable duration')
  for (let i = 1; i < c.length; i++) assert.ok(c[i].start >= c[i - 1].start)
})

test('layout: at most two lines of 42 characters; long text splits into several cues sharing the time', () => {
  const short = srt.segmentsToCues([{ start: 0, end: 3, text: 'A short line of dialogue.' }])
  assert.equal(short.length, 1)
  assert.deepEqual(short[0].lines, ['A short line of dialogue.'])

  const medium = srt.segmentsToCues([{ start: 0, end: 4, text: 'This sentence is a little longer than one line can hold.' }])
  assert.equal(medium.length, 1)
  assert.equal(medium[0].lines.length, 2)
  for (const l of medium[0].lines) assert.ok(l.length <= 42, l)

  const long = 'word '.repeat(60).trim()
  const cues = srt.segmentsToCues([{ start: 10, end: 40, text: long }])
  assert.ok(cues.length >= 3)
  for (const c of cues) { assert.ok(c.lines.length <= 2); for (const l of c.lines) assert.ok(l.length <= 42) }
  assert.equal(cues[0].start, 10)
  assert.equal(cues[cues.length - 1].end, 40)
  for (let i = 1; i < cues.length; i++) assert.ok(Math.abs(cues[i].start - cues[i - 1].end) < 1e-9, 'cues are contiguous')
  assert.equal(cues.map((c) => c.lines.join(' ')).join(' '), long, 'no words lost')
  // a very long single word is kept whole rather than cut
  assert.deepEqual(srt.wrapWords('x'.repeat(50) + ' y', 42), ['x'.repeat(50), 'y'])
})

test('an empty transcript gives an empty file (the job then fails with no_speech instead of writing junk)', () => {
  assert.equal(srt.segmentsToSrt([{ start: 0, end: 5, text: ' [BLANK_AUDIO]' }]).trim(), '')
})

// -------------------------------------------------------------------- arguments
const WIN = process.platform === 'win32'
const abs = (p) => (WIN ? 'C:\\w\\' : '/w/') + p

test('whisper arguments: a fixed, validated list; -tr only when translating; nothing shell-shaped gets through', () => {
  const a = whisper.buildWhisperArgs({ modelPath: abs('m.bin'), wavPath: abs('c.wav'), outPrefix: abs('chunk'), language: 'es', translate: true, threads: 3 })
  assert.deepEqual(a, ['-m', abs('m.bin'), '-f', abs('c.wav'), '-l', 'es', '-oj', '-of', abs('chunk'), '-t', '3', '-np', '-tr'])
  assert.ok(!whisper.buildWhisperArgs({ modelPath: abs('m.bin'), wavPath: abs('c.wav'), outPrefix: abs('chunk'), language: 'auto' }).includes('-tr'))
  const bad = (patch) => assert.throws(() => whisper.buildWhisperArgs({ modelPath: abs('m.bin'), wavPath: abs('c.wav'), outPrefix: abs('chunk'), ...patch }))
  bad({ language: 'en; rm -rf /' })
  bad({ language: '../x' })
  bad({ language: 'EN' })
  bad({ modelPath: 'relative/m.bin' })
  bad({ wavPath: '-o' })
  bad({ outPrefix: abs('x') + '\0' })
  assert.equal(whisper.buildWhisperArgs({ modelPath: abs('m.bin'), wavPath: abs('c.wav'), outPrefix: abs('chunk'), threads: 999 })[10], '16')
  assert.equal(whisper.buildWhisperArgs({ modelPath: abs('m.bin'), wavPath: abs('c.wav'), outPrefix: abs('chunk'), threads: 'x' })[10], '1')
  assert.deepEqual(whisper.buildDetectArgs({ modelPath: abs('m.bin'), wavPath: abs('c.wav'), threads: 2 }), ['-m', abs('m.bin'), '-f', abs('c.wav'), '-dl', '-t', '2'])
})

test('ffmpeg chunk arguments: 16 kHz mono PCM, first audio stream, input via file: prefix', () => {
  const a = whisper.buildChunkArgs({ input: '-evil.mkv', start: 300, duration: 302, out: abs('c.wav') })
  assert.equal(a[a.indexOf('-i') + 1], 'file:-evil.mkv', 'a path that starts with a dash cannot become an option')
  for (const pair of [['-ss', '300.000'], ['-t', '302.000'], ['-ac', '1'], ['-ar', '16000'], ['-map', '0:a:0'], ['-c:a', 'pcm_s16le']]) assert.equal(a[a.indexOf(pair[0]) + 1], pair[1])
  assert.ok(a.includes('-vn') && a.includes('-sn'))
  assert.equal(a[a.length - 1], abs('c.wav'))
})

test('language detection output is parsed; garbage is ignored', () => {
  assert.deepEqual(whisper.parseDetectedLanguage('x\nwhisper_full_with_state: auto-detected language: de (p = 0.913)\ny'), { language: 'de', probability: 0.913 })
  assert.equal(whisper.parseDetectedLanguage('nothing here'), null)
})

test('runChild: no shell, minimal environment, kills on abort and on timeout, never throws', async () => {
  process.env.BEEBO_SECRET_FOR_TEST = 'top-secret'
  const seen = []
  const spawnFn = (exe, args, opts) => { seen.push(opts); return require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { stdio: ['ignore', 'pipe', 'pipe'] }) }
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  const r = await whisper.runChild('x', [], { spawnFn, signal: ac.signal, timeoutMs: 8000 })
  assert.equal(r.cancelled, true)
  assert.equal(seen[0].shell, false)
  assert.ok(!('BEEBO_SECRET_FOR_TEST' in seen[0].env), 'the app environment is not handed to the child')
  const t = await whisper.runChild('x', [], { spawnFn, timeoutMs: 150 })
  assert.equal(t.timedOut, true)
  const e = await whisper.runChild('x', [], { spawnFn: () => { throw new Error('ENOENT') } })
  assert.equal(e.code, -1)
  delete process.env.BEEBO_SECRET_FOR_TEST
})

// ------------------------------------------------------------------ naming + label
test('aiSidecarPath: Name.<lang>.ai.srt beside the video; only plain language codes', () => {
  const v = path.join(WIN ? 'C:\\Movies' : '/movies', 'Big Fish (2003).mkv')
  assert.equal(path.basename(ai.aiSidecarPath(v, 'en')), 'Big Fish (2003).en.ai.srt')
  assert.equal(path.dirname(ai.aiSidecarPath(v, 'es')), path.dirname(v))
  for (const bad of ['', 'english', '../x', 'e n', 'EN1', 'e/n']) assert.throws(() => ai.aiSidecarPath(v, bad), /bad_language/, bad)
  assert.ok(ai.isAiQualifier('AI') && !ai.isAiQualifier('sdh'))
  assert.ok(ai.isAiLabel('English (AI-generated) · file'))
})

test('the subtitle menu (mediaInfo) labels AI files "(AI-generated)", keeps them apart from human files, sorts alongside', () => {
  const dir = F.tmpDir('beebo-lbl-')
  for (const n of ['Movie.mkv', 'Movie.en.srt', 'Movie.en.ai.srt', 'Movie.es.ai.srt', 'Movie.fr.forced.srt', 'Other.en.ai.srt']) fs.writeFileSync(path.join(dir, n), 'x')
  const list = mediaInfo.findSidecarSubtitles(path.join(dir, 'Movie.mkv'))
  const byLabel = Object.fromEntries(list.map((s) => [s.label, s]))
  assert.deepEqual(list.map((s) => s.label).sort(), ['English (AI-generated) · file', 'English · file', 'French (Forced) · file', 'Spanish (AI-generated) · file'])
  assert.equal(byLabel['English (AI-generated) · file'].aiGenerated, true)
  assert.equal(byLabel['English · file'].aiGenerated, false)
  assert.equal(new Set(list.map((s) => s.key)).size, list.length, 'each track has its own key')
  assert.ok(!list.some((s) => /Other/.test(s.label)))
})
