// Skip silence with a real ffmpeg, if this machine has one (BEEBO_FFMPEG or on the PATH):
// 1s tone, 3s silence, 1s tone -> the long pause is cut down and the tones are kept.
// Skipped, not failed, where there is no ffmpeg. Run: node --test test/podcast-silence.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { silenceArgs } = localRequire('./electron/podcastService')

const ff = process.env.BEEBO_FFMPEG || 'ffmpeg'
const have = spawnSync(ff, ['-version'], { windowsHide: true }).status === 0

test('skip silence with a real ffmpeg: a long pause is shortened, speech kept', { skip: have ? false : 'no ffmpeg on this machine' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-ns-'))
  try {
    const input = path.join(dir, 'in.wav')
    const made = spawnSync(ff, ['-v', 'error', '-y', '-filter_complex', 'sine=frequency=440:duration=1[a];anullsrc=r=44100:cl=mono:d=3[s];sine=frequency=440:duration=1[b];[a][s][b]concat=n=3:v=0:a=1', input], { windowsHide: true })
    assert.equal(made.status, 0, String(made.stderr))
    const output = path.join(dir, 'out.m4a')
    const run = spawnSync(ff, silenceArgs(input, output), { windowsHide: true })
    assert.equal(run.status, 0, String(run.stderr))
    const duration = (file) => {
      const r = spawnSync(ff, ['-i', file, '-f', 'null', '-'], { windowsHide: true })
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(String(r.stderr).split('\n').filter((l) => /time=/.test(l)).pop() || '')
      return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN
    }
    const before = duration(input)
    const after = duration(output)
    assert.ok(before > 4.8, 'input is about 5s: ' + before)
    assert.ok(after > 1.8 && after < 3.6, 'the 3s pause was cut down (about 0.2s kept): ' + after)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
