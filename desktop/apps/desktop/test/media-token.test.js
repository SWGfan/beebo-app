const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const server = localRequire('./electron/streamServer')

test('redactSecrets blanks media and login tokens in any logged text', () => {
  const line = 'GET /file?id=abc&mt=1789000000000.SiGnAtUrE_- failed; retry /api/x?token=eyJ.a.b&q=ok#frag'
  const out = server.redactSecrets(line)
  assert.equal(out, 'GET /file?id=abc&mt=[redacted] failed; retry /api/x?token=[redacted]&q=ok#frag')
  assert.doesNotMatch(out, /SiGnAtUrE|eyJ/)
  assert.equal(server.redactSecrets('/tvfile?id=x'), '/tvfile?id=x')
  assert.equal(server.redactSecrets('/a?format=mt'), '/a?format=mt')
})

// A real server on a spare port, a one-file library, no login cookie: the
// media token must work from the URL (Cast, <video>) and from the header (the
// phone's own player), and the server must say it reads the header.
test('media token works in the URL or the X-Beebo-Media-Token header', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-mt-test-'))
  const logged = []
  let info
  try {
    await fs.writeFile(path.join(dir, 'Clip (2020).mp4'), '0123456789')
    const data = {}
    const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
    const port = testPort()
    info = server.startStreamServer({
      port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir,
      getAllMoviesDirs: () => [dir], getAllTvShowsDirs: () => [],
      log: (m) => logged.push(m)
    })
    const base = 'http://127.0.0.1:' + info.port
    for (let i = 0; i < 50; i++) {
      try { await (await fetch(base + '/login', { redirect: 'manual' })).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const id = server.encodeId('Clip (2020).mp4')
    const mt = server.makeMediaToken(store, id)
    // Read every body: an unread response keeps fetch's socket paused and open,
    // and that socket then keeps the test process from exiting.
    const get = async (u, headers = {}) => {
      const res = await fetch(base + u, { redirect: 'manual', headers })
      const body = await res.text()
      return { status: res.status, headers: res.headers, text: async () => body }
    }

    let r = await get('/file?id=' + encodeURIComponent(id))
    assert.equal(r.status, 302, 'no token, no cookie -> login')
    assert.equal(r.headers.get('x-beebo-media-token-header'), '1')

    r = await get('/file?id=' + encodeURIComponent(id) + '&mt=' + encodeURIComponent(mt), { Range: 'bytes=2-5' })
    assert.equal(r.status, 206)
    assert.equal(await r.text(), '2345')

    r = await get('/file?id=' + encodeURIComponent(id), { 'X-Beebo-Media-Token': mt, Range: 'bytes=0-1' })
    assert.equal(r.status, 206)
    assert.equal(await r.text(), '01')

    r = await get('/file?id=' + encodeURIComponent(id), { 'X-Beebo-Media-Token': mt.replace(/.$/, 'x') })
    assert.equal(r.status, 302, 'a bad header token is not a login')

    const other = server.encodeId('Other.mp4')
    r = await get('/file?id=' + encodeURIComponent(other), { 'X-Beebo-Media-Token': mt })
    assert.equal(r.status, 302, 'a token is only good for its own id')

    assert.equal(logged.some((l) => /[?&]mt=(?!\[redacted\])/.test(l)), false)
  } finally {
    if (info) await new Promise((r) => info.close(r))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
