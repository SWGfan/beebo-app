// ONE optional end-to-end test with the real ffmpeg: synthesises a tiny "season" (a shared jingle
// at different offsets, black credits at the end) as real video files, runs the real scanner over
// them and checks the answers. Skipped automatically when no ffmpeg/ffprobe is available
// (resources/ffmpeg, BEEBO_FFMPEG or PATH). Run: node --test test/intro-detect-ffmpeg.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const convert = localRequire('./electron/convert')
const J = localRequire('./electron/introDetectJob')
const M = localRequire('./electron/markerModel')
const D = localRequire('./electron/introDetect')
const A = require('./helpers/syntheticAudio')

function findTool(name) {
  const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
  if (fromApp) return fromApp
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')
const HAVE = !!(FFMPEG && FFPROBE)

function writeWav(file, int16, rate = 8000) {
  const data = Buffer.alloc(int16.length * 2)
  for (let i = 0; i < int16.length; i++) data.writeInt16LE(int16[i], i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, data]))
}

// A real video file: bright test pattern, then `blackSeconds` of black; audio from a WAV.
function makeVideo(file, wav, seconds, blackSeconds) {
  const bright = seconds - blackSeconds
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=10:duration=${bright}`]
  if (blackSeconds > 0) args.push('-f', 'lavfi', '-i', `color=c=black:size=160x90:rate=10:duration=${blackSeconds}`)
  args.push('-i', wav)
  const audioIdx = blackSeconds > 0 ? 2 : 1
  if (blackSeconds > 0) args.push('-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]')
  else args.push('-map', '0:v')
  args.push('-map', `${audioIdx}:a`, '-c:v', 'mpeg4', '-q:v', '5', '-g', '10', '-c:a', 'aac', '-b:a', '64k', '-shortest', file)
  const r = spawnSync(FFMPEG, args, { windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('could not synthesise ' + file + ': ' + (r.stderr || '').slice(-400))
}

test('real ffmpeg: a synthetic season and a film are scanned end to end', { skip: HAVE ? false : 'no ffmpeg/ffprobe available' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-intro-e2e-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // Directory and file names full of shell/ffmpeg trouble: spaces, quotes, ampersand, semicolon, parentheses.
  const showDir = path.join(root, "Some Show (2020) & Co's; \"cut\"".replace(/"/g, ''))
  fs.mkdirSync(showDir, { recursive: true })
  const jingle = A.jingle(20, 99)
  const ats = [10, 35, 60, 22]
  const items = []
  ats.forEach((at, i) => {
    const bg = A.background(150, 9000 + i)
    const s0 = at * A.SR
    for (let k = 0; k < jingle.length; k++) bg[s0 + k] = bg[s0 + k] * 0.15 + jingle[k]
    const wav = path.join(root, `ep${i}.wav`)
    writeWav(wav, A.toInt16(bg))
    const file = path.join(showDir, `Some Show S01E0${i + 1} - it's a "title" & more.mkv`.replace(/"/g, ''))
    makeVideo(file, wav, 150, 70)
    items.push({ kind: 'tv', id: 'e' + i, path: file, showKey: 'show', showName: 'Some Show', season: 1, episode: i + 1, label: path.basename(file) })
  })
  // A film with black credits at the end (its own black tail, no intro to look for).
  const filmWav = path.join(root, 'film.wav')
  writeWav(filmWav, A.toInt16(A.background(400, 4242)))
  const film = path.join(root, 'A Film; (2021).mkv')
  makeVideo(film, filmWav, 400, 70)
  items.push({ kind: 'movie', id: 'm', path: film, label: 'film' })
  // A film with no black anywhere: nothing must be reported.
  const plainWav = path.join(root, 'plain.wav')
  writeWav(plainWav, A.toInt16(A.background(400, 4343)))
  const plain = path.join(root, 'Plain Film.mkv')
  makeVideo(plain, plainWav, 400, 0)
  items.push({ kind: 'movie', id: 'p', path: plain, label: 'plain' })

  const store = { data: {}, get(k) { return this.data[k] }, set(k, v) { this.data[k] = JSON.parse(JSON.stringify(v)) } }
  const scanner = J.createIntroScanner({
    store,
    listItems: () => items,
    ffmpegPath: () => FFMPEG,
    ffprobePath: () => FFPROBE,
    cacheDir: () => path.join(root, 'fpcache'),
    pauseBetweenMs: 0
  })
  const t0 = Date.now()
  const r = await scanner.runPass()
  const elapsed = Date.now() - t0
  assert.equal(r.ok, true, JSON.stringify(scanner.status()))
  t.diagnostic(`real ffmpeg scan of 4 episodes + 2 films (150-400 s each): ${(elapsed / 1000).toFixed(1)} s total`)

  items.slice(0, 4).forEach((it, i) => {
    const rec = scanner.lookup(it.path)
    assert.ok(rec, 'record for ' + it.label)
    const eff = M.effectiveMarkers({ viewer: {}, auto: rec, durationSeconds: rec.durationSec })
    assert.equal(eff.introSource, 'auto', `intro for ${it.label}: ${JSON.stringify(rec)}`)
    assert.ok(Math.abs(eff.introStartSeconds - ats[i]) < 2, `intro start ${eff.introStartSeconds} vs ${ats[i]}`)
    assert.ok(Math.abs(eff.introEndSeconds - (ats[i] + 20)) < 2, `intro end ${eff.introEndSeconds} vs ${ats[i] + 20}`)
    assert.equal(eff.creditsSource, 'auto', `credits for ${it.label}: ${JSON.stringify(rec)}`)
    assert.ok(Math.abs(eff.creditsStartSeconds - 80) < 3, `credits start ${eff.creditsStartSeconds} vs 80`)
  })
  const filmRec = scanner.lookup(film)
  const filmEff = M.effectiveMarkers({ viewer: {}, auto: filmRec, durationSeconds: filmRec.durationSec })
  assert.equal(filmEff.creditsSource, 'auto', JSON.stringify(filmRec))
  assert.ok(Math.abs(filmEff.creditsStartSeconds - 330) < 3, `film credits ${filmEff.creditsStartSeconds}`)
  const plainRec = scanner.lookup(plain)
  assert.equal(M.effectiveMarkers({ viewer: {}, auto: plainRec, durationSeconds: plainRec.durationSec }).source, null, 'nothing invented for a film with no dark tail')
  assert.equal(scanner.status().itemsDone, 6)
  assert.equal(D.buildPcmArgs(items[0].path, 60).filter((a) => a.includes('Some Show')).length, 1)
})
