// Shared real-media fixture for the Jellyfin-compatible API tests: two films (one mp4, one mkv with two audio tracks and a subtitle),
// a small music library and a running Beebo server over them. Needs ffmpeg/ffprobe; SKIP says why when they are missing.
// Not a test file itself.
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { fixture, localRequire } = require('./jellyfin-fixture')

function findTool(name) {
  const convert = localRequire('./electron/convert')
  const fromApp = name === 'ffmpeg' ? convert.ffmpegPath() : convert.ffprobePath()
  if (fromApp) return fromApp
  const r = spawnSync(name, ['-version'], { windowsHide: true })
  return r.status === 0 ? name : null
}
const FFMPEG = findTool('ffmpeg')
const FFPROBE = findTool('ffprobe')
const SKIP = !(FFMPEG && FFPROBE) ? 'ffmpeg/ffprobe not found' : false

// Fake video uses whichever H.264-class encoder this ffmpeg has: the bundled LGPL build has no libx264.
const synthVideo = () => { const l = String(spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || ''); return /libx264/.test(l) ? ['-c:v', 'libx264', '-preset', 'ultrafast'] : /libopenh264/.test(l) ? ['-c:v', 'libopenh264'] : ['-c:v', 'mpeg4'] }
const ff = (args) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...args], { windowsHide: true })
  assert.equal(r.status, 0, 'ffmpeg ' + args.slice(0, 4).join(' ') + ': ' + String(r.stderr || ''))
}

async function makeMedia({ root, moviesDir }) {
  const srt = path.join(root, 'en.srt')
  await fsp.writeFile(srt, '1\n00:00:00,500 --> 00:00:02,000\nHello there\n\n2\n00:00:02,500 --> 00:00:04,000\nGeneral Kenobi\n')
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=100', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=100', ...synthVideo(), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(moviesDir, 'Clip (2020).mp4')])
  ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', ...synthVideo(), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng', path.join(moviesDir, 'Multi (2021).mkv')])
  const music = path.join(root, 'Music', 'Test Artist', 'First Album')
  await fsp.mkdir(music, { recursive: true })
  const cover = path.join(root, 'cover.png')
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=16x16', '-frames:v', '1', cover])
  const tags = (o) => Object.entries(o).flatMap(([k, v]) => ['-metadata', k + '=' + v])
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'png', '-disposition:v', 'attached_pic',
    ...tags({ title: 'Opening Song', artist: 'Test Artist', album_artist: 'Test Artist', album: 'First Album', track: '1/2', date: '2001', genre: 'Rock' }), path.join(music, '01 Opening Song.flac')])
  ff(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-c:a', 'flac', ...tags({ title: 'Closing Song', artist: 'Test Artist', album_artist: 'Test Artist', album: 'First Album', track: '2/2', date: '2001', genre: 'Rock' }), path.join(music, '02 Closing Song.flac')])
}

async function mediaFixture(opts = {}) {
  const musicLibrary = localRequire('./electron/musicLibrary')
  let musicRoot = ''
  const lib = musicLibrary.createMusicLibrary({ getDirs: () => [musicRoot], getCacheDir: () => path.join(musicRoot, '..', 'cache'), readTags: musicLibrary.defaultTagReader({ ffprobePath: FFPROBE, ffmpegPath: FFMPEG }) })
  const f = await fixture({
    withStandardFiles: false,
    ...opts,
    prepare: async (ctx) => { await makeMedia(ctx); musicRoot = path.join(ctx.root, 'Music') },
    serverExtra: {
      playback: { tmpRoot: path.join(require('node:os').tmpdir(), 'beebo-jf-pb-' + process.pid + '-' + Date.now()), ffmpegPath: () => FFMPEG, ffprobePath: () => FFPROBE },
      music: lib,
      ...(opts.serverExtra || {}),
    },
  })
  await lib.scan()
  return f
}

module.exports = { mediaFixture, makeMedia, SKIP, FFMPEG, FFPROBE, ff }
