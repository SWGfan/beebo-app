'use strict'
// A stand-in for ffmpeg / ffprobe in the Speech Pack tests. Never decodes anything.
//   ffprobe: `--probe ...` prints a duration taken from the file name (".d<seconds>." e.g. Movie.d25.mkv -> 25).
//   ffmpeg : writes a fake "wav" (JSON: { start, duration }) to the LAST argument; the input name containing
//            "noaudio" fails the way ffmpeg does when there is no audio stream.
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--probe') {
  const input = args[args.length - 1] || ''
  const m = /\.d(\d+)\./.exec(input)
  process.stdout.write(String(m ? Number(m[1]) : 60) + '\n')
  process.exit(0)
}
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
const input = val('-i') || ''
if (/noaudio/i.test(input)) { process.stderr.write("Stream map '0:a:0' matches no streams.\n"); process.exit(1) }
const out = args[args.length - 1]
fs.writeFileSync(out, JSON.stringify({ start: Number(val('-ss')), duration: Number(val('-t')) }))
process.exit(0)
