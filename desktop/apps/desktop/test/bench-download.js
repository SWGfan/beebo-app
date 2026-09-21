// Local download benchmark: serves a synthetic film through electron/fileServe.js over loopback
// HTTP and times a Range-capable client, including an interrupted-then-resumed transfer that is
// checked byte for byte. Not a *.test.js file, so the CI runner skips it.
//
//   node test/bench-download.js [--mb 500] [--hwm 65536,262144,1048576,4194304] [--runs 3]
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { serveFile } = require('../electron/fileServe')

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i > 0 ? process.argv[i + 1] : dflt
}
const MB = Number(arg('mb', 500))
const HWMS = String(arg('hwm', '65536,262144,1048576,4194304')).split(',').map(Number)
const RUNS = Number(arg('runs', 3))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-bench-'))
const file = path.join(dir, 'film.mkv')
const block = crypto.randomBytes(1024 * 1024)
const fd = fs.openSync(file, 'w')
for (let i = 0; i < MB; i++) {
  block.writeUInt32BE(i, 0)
  fs.writeSync(fd, block)
}
fs.closeSync(fd)
const size = fs.statSync(file).size

function serve(hwm) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => serveFile(req, res, file, { mime: 'video/x-matroska', streamOpts: { highWaterMark: hwm } }))
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function download(port, headers, onData) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
      let n = 0
      res.on('data', (c) => { n += c.length; if (onData) onData(c) })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: n }))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

async function timed(port, headers) {
  const t0 = process.hrtime.bigint()
  const r = await download(port, headers)
  const s = Number(process.hrtime.bigint() - t0) / 1e9
  return { ...r, seconds: s, mbps: r.bytes / 1048576 / s }
}

async function main() {
  console.log(`file ${MB} MB, ${RUNS} runs each, Node ${process.version}`)
  for (const hwm of HWMS) {
    const server = await serve(hwm)
    const port = server.address().port
    const runs = []
    for (let i = 0; i < RUNS; i++) runs.push((await timed(port, {})).mbps)
    console.log(`highWaterMark ${String(hwm).padStart(8)}: ${runs.map((x) => x.toFixed(0)).join(' / ')} MB/s  (median ${runs.slice().sort((a, b) => a - b)[Math.floor(runs.length / 2)].toFixed(0)})`)
    server.close()
  }

  const server = await serve(1 << 20)
  const port = server.address().port
  const head = await download(port, {})
  const etag = head.headers.etag
  const whole = crypto.createHash('sha256')
  await new Promise((resolve) => fs.createReadStream(file).on('data', (c) => whole.update(c)).on('end', resolve))

  const cut = Math.floor(size * 0.37) + 12345
  const got = crypto.createHash('sha256')
  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let n = 0
      res.on('data', (c) => {
        const take = Math.min(c.length, cut - n)
        got.update(c.subarray(0, take))
        n += take
        if (n >= cut) { req.destroy(); resolve() }
      })
    })
    req.on('error', () => {})
  })
  const t0 = process.hrtime.bigint()
  const rest = await download(port, { Range: `bytes=${cut}-`, 'If-Range': etag }, (c) => got.update(c))
  const s = Number(process.hrtime.bigint() - t0) / 1e9
  const ok = rest.status === 206 && got.digest('hex') === whole.digest('hex')
  console.log(`resume from byte ${cut} with If-Range: HTTP ${rest.status}, ${(rest.bytes / 1048576).toFixed(0)} MB in ${s.toFixed(2)} s, joined file ${ok ? 'byte-exact' : 'MISMATCH'}`)
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
  if (!ok) process.exit(1)
}
main()
