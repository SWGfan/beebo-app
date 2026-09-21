'use strict'
// A stand-in for whisper-cli in the Speech Pack tests. No real model, no audio decoding.
//   -f <wav>  a JSON file written by fake-ffmpeg.js: { start, duration } seconds
//   -m <model> the model file's TEXT steers the behaviour:
//        contains "SLOW"  -> the first run for the FIRST chunk (start 0) takes 3 s (then a marker file makes later runs fast)
//        contains "FAIL"  -> exit code 2
//   -dl       language detection only: prints "auto-detected language: es (p = 0.95)" on stderr
//   otherwise writes <of>.json like `whisper-cli -oj`: a line early in the chunk and a "tail" line 1 s before the
//   chunk's end (inside the overlap for every chunk but the last).
// Every call is appended to <model>.calls.log as one JSON line so tests can check the exact arguments.
const fs = require('node:fs')
const args = process.argv.slice(2)
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
const modelPath = val('-m')
const model = fs.readFileSync(modelPath, 'utf8')
fs.appendFileSync(modelPath + '.calls.log', JSON.stringify(args) + '\n')
if (/FAIL/.test(model)) process.exit(2)
const wav = JSON.parse(fs.readFileSync(val('-f'), 'utf8'))
if (args.includes('-dl')) {
  process.stderr.write('whisper_full_with_state: auto-detected language: es (p = 0.95)\n')
  process.exit(0)
}
const finish = () => {
  const lang = val('-l') === 'auto' ? 'es' : val('-l')
  const tr = args.includes('-tr')
  const seg = (fromMs, toMs, text) => ({ timestamps: {}, offsets: { from: fromMs, to: toMs }, text: ' ' + text })
  const out = {
    result: { language: lang },
    transcription: [
      seg(1000, 3000, `line@${wav.start}${tr ? ' translated' : ''}`),
      seg(Math.round((wav.duration - 1) * 1000), Math.round(wav.duration * 1000), `tail@${wav.start}`)
    ]
  }
  fs.writeFileSync(val('-of') + '.json', JSON.stringify(out))
  process.exit(0)
}
const marker = `${modelPath}.slowdone.${wav.start}`
if (/SLOW/.test(model) && wav.start === 0 && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1')
  setTimeout(finish, 3000)
} else finish()
