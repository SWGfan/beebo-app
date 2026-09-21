const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const server = localRequire('./electron/streamServer')

// The real /file route, the way the phone's offline download uses it: a media token, Range,
// If-Range with what the first reply said, HEAD, and a body that is never compressed.
test('/file serves a download: validators, ranges, resume with If-Range, HEAD, no compression', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-dl-route-'))
  let info
  try {
    const bytes = crypto.randomBytes(3 * 1024 * 1024 + 17)
    await fs.writeFile(path.join(dir, 'Big Film (2021).mkv'), bytes)
    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [], log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/login', { redirect: 'manual' })).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const id = server.encodeId('Big Film (2021).mkv')
    const url = base + '/file?id=' + encodeURIComponent(id) + '&mt=' + encodeURIComponent(server.makeMediaToken(store, id))
    const get = async (headers = {}, method = 'GET') => {
      const r = await fetch(url, { method, redirect: 'manual', headers: { 'X-Beebo-Download': '1', ...headers } })
      return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }
    }

    const whole = await get({ 'Accept-Encoding': 'gzip, deflate, br' })
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('content-encoding'), null, 'a film is never compressed')
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.equal(whole.headers.get('content-length'), String(bytes.length))
    assert.match(whole.headers.get('content-type'), /matroska/)
    assert.ok(whole.body.equals(bytes))
    const etag = whole.headers.get('etag')
    assert.ok(etag)
    assert.ok(whole.headers.get('last-modified'))

    const head = await get({}, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('etag'), etag)
    assert.equal(head.headers.get('content-length'), String(bytes.length))
    assert.equal(head.body.length, 0)

    // An interrupted download resumes from where its .part ends, guarded by If-Range.
    const cut = 1_234_567
    const rest = await get({ Range: `bytes=${cut}-`, 'If-Range': etag })
    assert.equal(rest.status, 206)
    assert.equal(rest.headers.get('content-range'), `bytes ${cut}-${bytes.length - 1}/${bytes.length}`)
    assert.ok(Buffer.concat([bytes.subarray(0, cut), rest.body]).equals(bytes), 'part + resumed range is the file')

    const changed = await get({ Range: `bytes=${cut}-`, 'If-Range': '"not-this-file"' })
    assert.equal(changed.status, 200, 'a changed file is sent whole, not spliced')
    assert.ok(changed.body.equals(bytes))

    const done = await get({ Range: `bytes=${bytes.length}-` })
    assert.equal(done.status, 416)
    assert.equal(done.headers.get('content-range'), `bytes */${bytes.length}`)

    const tail = await get({ Range: 'bytes=-1000' })
    assert.equal(tail.status, 206)
    assert.ok(tail.body.equals(bytes.subarray(bytes.length - 1000)))
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The app and installer downloads a family member opens from a browser: a dropped connection
// must be resumable, so they carry Accept-Ranges and a validator like the film route does.
test('/download/android-app can be resumed with a Range request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-dl-apk-'))
  let info
  try {
    const apk = crypto.randomBytes(700_000)
    const apkPath = path.join(dir, 'Beebo.apk')
    await fs.writeFile(apkPath, apk)
    const data = { androidApkPath: apkPath }
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [], log: () => {}
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/login', { redirect: 'manual' })).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const get = async (headers = {}, method = 'GET') => {
      const r = await fetch(base + '/download/android-app', { method, headers })
      return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }
    }
    const whole = await get()
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('content-type'), 'application/vnd.android.package-archive')
    assert.match(whole.headers.get('content-disposition'), /attachment; filename="Beebo Entertainment.apk"/)
    assert.equal(whole.headers.get('accept-ranges'), 'bytes')
    assert.ok(whole.body.equals(apk))
    const rest = await get({ Range: 'bytes=500000-', 'If-Range': whole.headers.get('etag') })
    assert.equal(rest.status, 206)
    assert.ok(rest.body.equals(apk.subarray(500000)))
    assert.match(rest.headers.get('content-disposition'), /attachment/)
    assert.equal((await get({}, 'HEAD')).headers.get('content-length'), String(apk.length))
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
