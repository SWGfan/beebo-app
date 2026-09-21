'use strict'
// End-to-end check of a running headless Beebo server.
//   node docker/smoke.js --base https://localhost:47811 --log server.log [--expect-title "Test Movie"]
// Waits for /api/ping, checks the first-run setup flow prints a code and only
// accepts it once, signs in, waits for the library scan to find the title, then
// asks for an HLS stream and fetches the playlist and its first segment.
const fs = require('fs')
const http = require('http')
const https = require('https')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const base = new URL(opt('base', 'https://localhost:47811'))
const logFile = opt('log', '')
const expectTitle = opt('expect-title', '')
const password = 'smoke-test-password-1'

function call(method, path, { body, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const lib = base.protocol === 'https:' ? https : http
    const req = lib.request({ host: base.hostname, port: base.port, method, path, rejectUnauthorized: false, headers: Object.assign(data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ status: res.statusCode, headers: res.headers, buf, text: raw ? '' : buf.toString('utf8') })
      })
    })
    req.setTimeout(60000, () => req.destroy(new Error('request timed out: ' + path)))
    req.on('error', reject)
    if (data !== null) req.write(data)
    req.end()
  })
}

let finished = false
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.error('FAIL - the script ended before every check ran')
    process.exitCode = 1
  }
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let step = 0
function ok(message) {
  step += 1
  console.log(`ok ${step} - ${message}`)
}
function fail(message) {
  console.error(`FAIL - ${message}`)
  process.exit(1)
}
function check(cond, message) {
  if (!cond) fail(message)
  ok(message)
}

async function waitFor(what, fn, ms) {
  const started = Date.now()
  let last
  while (Date.now() - started < ms) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      last = err
    }
    await sleep(1500)
  }
  fail(`timed out waiting for ${what}${last ? ': ' + last.message : ''}`)
}

;(async () => {
  await waitFor('/api/ping', async () => {
    const r = await call('GET', '/api/ping')
    return r.status === 200 && JSON.parse(r.text).ok === true
  }, 180000)
  ok('/api/ping answers')

  const setupPage = await call('GET', '/setup')
  check(setupPage.status === 200 && /Set up Beebo/.test(setupPage.text), 'setup page is served while there is no owner')

  const log = logFile ? fs.readFileSync(logFile, 'utf8') : ''
  const codes = [...log.matchAll(/Setup code: ([2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4})/g)]
  check(codes.length >= 1, 'the server log printed a setup code')
  const code = codes[codes.length - 1][1]

  const wrong = await call('POST', '/api/headless/setup', { body: { code: 'ZZZZ-ZZZZ-ZZZZ', username: 'owner', password } })
  check(wrong.status === 403, 'a wrong setup code is refused (403)')
  const made = await call('POST', '/api/headless/setup', { body: { code, username: 'owner', password } })
  check(made.status === 200, 'the printed code creates the owner account')
  const again = await call('POST', '/api/headless/setup', { body: { code, username: 'intruder', password } })
  check(again.status !== 200, 'setup refuses a second owner')
  const pageAfter = await call('GET', '/setup')
  check(pageAfter.status !== 200, 'setup page is gone once an owner exists')

  const login = await call('POST', '/api/login', { body: { username: 'owner', password } })
  check(login.status === 200, 'the owner can sign in')
  const auth = { Authorization: 'Bearer ' + JSON.parse(login.text).token }

  const admin = await call('GET', '/api/admin/summary', { headers: auth })
  check(admin.status === 200, 'the admin API answers over HTTPS')

  let movie = null
  await waitFor('the library scan to find the test video', async () => {
    const r = await call('GET', '/api/movies', { headers: auth })
    if (r.status !== 200) return false
    const list = JSON.parse(r.text)
    const items = Array.isArray(list) ? list : list.movies || list.items || []
    movie = items.find((m) => !expectTitle || String(m.title || m.name || m.fileName || '').toLowerCase().includes(expectTitle.toLowerCase()))
    return !!movie
  }, 120000)
  ok('the library scan found the test video')

  const start = await call('POST', '/api/playback/start', { headers: auth, body: { kind: 'movie', id: movie.id, quality: '480p' } })
  check(start.status === 200, 'playback/start answers (' + start.status + ')')
  const started = JSON.parse(start.text)
  const playlistUrl = started.url || started.hlsUrl || (started.stream && started.stream.url)
  check(typeof playlistUrl === 'string' && playlistUrl.includes('.m3u8'), 'playback/start returned an HLS playlist url')

  const playlist = await call('GET', playlistUrl, { headers: auth })
  check(playlist.status === 200 && playlist.text.startsWith('#EXTM3U'), 'the HLS playlist is fetched')
  const segLine = playlist.text.split(/\r?\n/).find((l) => /seg-\d+\.ts/.test(l))
  check(!!segLine, 'the playlist lists segments')
  const segUrl = new URL(segLine.trim(), new URL(playlistUrl, base)).pathname + (segLine.includes('?') ? '?' + segLine.split('?')[1] : '')
  const seg = await call('GET', segUrl, { headers: auth, raw: true })
  check(seg.status === 200 && seg.buf.length > 1000 && seg.buf[0] === 0x47, `the first segment is a real MPEG-TS transcode (${seg.buf.length} bytes)`)

  finished = true
  console.log(`all ${step} checks passed`)
})().catch((err) => fail(err.stack || String(err)))
