// Security review F9: every ffmpeg/ffprobe invocation with a user-library input goes through
// electron/ffmpegArgs.js (file: prefix + -protocol_whitelist file,crypto,pipe).
// Run: node --test test/ffmpeg-args.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { localRequire } = require('./security-harness')
const ff = localRequire('./electron/ffmpegArgs')
const hls = localRequire('./electron/hlsTranscoder')
const tracks = localRequire('./electron/playbackTracks')
const trickplay = localRequire('./electron/trickplayRules')

const HOSTILE = [
  'concat:/etc/passwd|/etc/shadow',
  'http://169.254.169.254/latest/meta-data/',
  'https://evil.example/x.mkv',
  'subfile,,start,0,end,0,,:/etc/passwd',
  'tcp://127.0.0.1:22',
  'rtmp://evil.example/live',
  'ffconcat:x',
  '-i evil.mkv',
  '-f lavfi -i testsrc',
  '-attack.mkv',
  'pipe:0',
  'C:\\Movies\\a b (2020) & c; `id` $(x).mkv',
  'data:text/plain;base64,AAAA',
  'file:///etc/passwd',
  'x.mkv\\..\\..\\y.mkv'
]

test('safeInput / inputArgs: file: prefix, protocol whitelist before -i, bad paths refused', () => {
  assert.equal(ff.safeInput('C:\\m\\a.mkv'), 'file:C:\\m\\a.mkv')
  assert.equal(ff.safeInput('/m/a.mkv'), 'file:/m/a.mkv')
  assert.deepEqual(ff.inputArgs('/m/a.mkv'), ['-protocol_whitelist', 'file,crypto,pipe', '-i', 'file:/m/a.mkv'])
  for (const bad of ['', null, undefined, 'a\0b', 'a\nb', 'a\rb']) assert.throws(() => ff.safeInput(bad), /invalid input path/, JSON.stringify(bad))
  for (const h of HOSTILE) {
    const a = ff.inputArgs(h)
    assert.equal(a.length, 4)
    assert.equal(a[2], '-i')
    assert.equal(a[3], 'file:' + h, 'the hostile name is one argument, prefixed, unchanged')
    assert.ok(a[3].startsWith('file:'), h + ' can only be a file path now')
    assert.equal(a.filter((x) => x === h).length, 0, 'never appears bare')
  }
  assert.ok(!ff.PROTOCOL_WHITELIST.split(',').some((p) => ['http', 'https', 'tcp', 'udp', 'rtp', 'rtmp', 'concat', 'subfile', 'data', 'ftp'].includes(p)))
})

test('the argument builders never let a hostile name stand alone', () => {
  const tr = { video: { width: 1920, height: 1080, streamIndex: 0 }, audio: [], subtitles: [] }
  for (const h of HOSTILE) {
    const builders = {
      hls: hls.buildTranscodeArgs({ input: h, tracks: tr, quality: '720p', encoder: 'libx264', outDir: '/tmp/o' }),
      subtitleExtract: tracks.extractArgs(h, 3, '/tmp/o.vtt'),
      trickplay: trickplay.ffmpegArgs(h, 10, 160, '/tmp/%06d.jpg')
    }
    for (const [name, args] of Object.entries(builders)) {
      assert.ok(args.every((a) => typeof a === 'string'), name)
      assert.equal(args.includes(h), false, `${name}: ${h} appears bare`)
      const i = args.indexOf('-i')
      assert.ok(i > 0 && args[i + 1] === 'file:' + h, `${name}: input after -i is file:-prefixed`)
      assert.equal(args[i - 2], '-protocol_whitelist', `${name}: whitelist immediately before -i`)
      assert.equal(args[i - 1], 'file,crypto,pipe')
    }
  }
})

test('every ffmpeg/ffprobe input in electron/*.js goes through the shared helper (source scan)', () => {
  const dir = path.join(__dirname, '..', 'electron')
  const offenders = []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'ffmpegArgs.js')
  for (const f of files) {
    fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).forEach((line, n) => {
      const code = line.replace(/\/\/.*$/, '')
      // a bare '-i' followed by anything but a synthetic (lavfi) source or the shared helper
      if (/'-i'\s*,/.test(code) && !/lavfi|color=c=|inputArg|'pipe:0'/.test(code)) offenders.push(`${f}:${n + 1}: ${line.trim()}`)
      // ffprobe callers pass the path as the last positional argument: it must still go through the helper
      if (/'-show_(streams|format|chapters|entries)'|PROBE_ARGS\b/.test(code) && /spawn|execFile|runProcess|\[\.\.\./.test(code) && /'-v'|PROBE_ARGS/.test(code) && !/inputArgs|const PROBE_ARGS|PROBE_ARGS,$|PROBE_ARGS = /.test(code)) offenders.push(`${f}:${n + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], 'bare "-i" inputs:\n' + offenders.join('\n'))
  // ffprobe callers that used to pass the path as the last positional argument
  for (const [f, pat] of [['convert.js', /rules\.FFPROBE_ARGS, filePath\]/], ['playbackTracks.js', /PROBE_ARGS, filePath\]/], ['libraryInfo.js', /PROBE_ARGS, filePath\]/], ['musicLibrary.js', /'-show_streams', file\]/]]) {
    assert.equal(pat.test(fs.readFileSync(path.join(dir, f), 'utf8')), false, f + ' still passes a bare path to ffprobe')
  }
})

// ------------------------------------------------- against a real ffmpeg ----

function findTool(name) {
  const candidates = [path.join(__dirname, '..', 'resources', 'ffmpeg', name + (process.platform === 'win32' ? '.exe' : '')), name]
  for (const c of candidates) {
    try { if (spawnSync(c, ['-version'], { windowsHide: true }).status === 0) return c } catch { /* next */ }
  }
  return null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')

test('real ffmpeg/ffprobe: file: paths (with a Windows drive letter, spaces, a leading dash) work with the whitelist; a playlist cannot reach the network', { skip: !FFMPEG || !FFPROBE ? 'ffmpeg/ffprobe not installed here' : false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-ffargs-'))
  let server
  try {
    const run = (exe, args, opts = {}) => spawnSync(exe, args, { windowsHide: true, timeout: 30000, encoding: 'utf8', ...opts })
    const wav = path.join(dir, 'My Clip (2020) & more.wav')
    assert.equal(run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav]).status, 0, 'made a test file')

    // 1. Normal use: the absolute path (C:\... on Windows) through the helper.
    let r = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', ...ff.inputArgs(wav)])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(Number(r.stdout.trim()) > 0.5, 'duration read: ' + r.stdout)
    r = run(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...ff.inputArgs(wav), '-f', 'null', '-'])
    assert.equal(r.status, 0, r.stderr)

    // 2. A relative name that starts with '-' is a file, not an option (run from that folder).
    fs.copyFileSync(wav, path.join(dir, '-dash.wav'))
    r = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', ...ff.inputArgs('-dash.wav')], { cwd: dir })
    assert.equal(r.status, 0, r.stderr)

    // 3. A "media file" that is really an HLS playlist pointing at a web server. With the helper
    //    ffmpeg refuses (protocol not on the whitelist) and never connects.
    let hits = 0
    server = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end('x') })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/seg.ts`
    const evil = path.join(dir, 'evil.m3u8')
    fs.writeFileSync(evil, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${url}\n#EXT-X-ENDLIST\n`)
    r = run(FFPROBE, ['-v', 'error', '-show_format', ...ff.inputArgs(evil)])
    assert.notEqual(r.status, 0, 'the playlist is refused')
    assert.match(String(r.stderr), /whitelist|not on whitelist|Invalid data/i, r.stderr)
    assert.equal(hits, 0, 'the protected command never touched the network')
    // and the same file through a bare path, as before the fix, is what the whitelist exists to stop
    // (informational: some builds already refuse, so only the protected result is asserted above).
    // 4. The whitelisted flag is also accepted by ffmpeg itself when transcoding a normal file.
    r = run(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...ff.inputArgs(wav), '-t', '0.2', path.join(dir, 'out.wav')])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(fs.statSync(path.join(dir, 'out.wav')).size > 0)
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
