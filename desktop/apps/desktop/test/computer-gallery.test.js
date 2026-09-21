const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fss = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const moduleUnderTest = localRequire('./electron/computerGallery')
const serverModule = localRequire('./electron/streamServer')
const auth = localRequire('./electron/auth')
const parser = localRequire('@babel/parser')

test('Computer gallery: nested browsing, bounded search, cursor isolation and file restrictions', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-gallery-test-'))
  try {
    await fs.mkdir(path.join(fixture, 'Random folder'))
    await fs.mkdir(path.join(fixture, 'Empty'))
    await fs.writeFile(path.join(fixture, 'Random folder', 'Holiday 2026.JPG'), 'photo')
    await fs.writeFile(path.join(fixture, 'clip.mp4'), '0123456789')
    await fs.writeFile(path.join(fixture, 'secret.txt'), 'not media')
    const gallery = moduleUnderTest.createComputerGallery({ roots: async () => [fixture], batchSize: 2, maxResults: 2 })
    const list = async (dir, q = '', cursor = '') => gallery.library('owner', new URLSearchParams({ dir, q, cursor }))
    assert.equal((await list('')).folders.length, 1)
    let page = await list(fixture), folders = [...page.folders], items = [...page.items]
    while (page.nextCursor) {
      page = await list(fixture, '', page.nextCursor)
      folders.push(...page.folders); items.push(...page.items)
    }
    assert.deepEqual(folders.map(x => x.name).sort(), ['Empty', 'Random folder'])
    assert.deepEqual(items.map(x => x.name), ['clip.mp4'])
    assert.equal((await list(path.join(fixture, 'Empty'))).items.length, 0)
    page = await list(fixture, 'HOLIDAY')
    const matches = [...page.items]
    if (page.nextCursor) await assert.rejects(gallery.library('guest', new URLSearchParams({ dir: fixture, q: 'holiday', cursor: page.nextCursor })), e => e.status === 410)
    while (page.nextCursor) { page = await list(fixture, 'HOLIDAY', page.nextCursor); matches.push(...page.items) }
    assert.deepEqual(matches.map(x => x.name), ['Holiday 2026.JPG'])
    assert.equal((await gallery.resolve(matches[0].rel, true)).st.size, 5)
    await assert.rejects(gallery.resolve(path.join(fixture, 'secret.txt'), true), e => e.status === 403)
    await assert.rejects(gallery.resolve(fixture + '/../outside.jpg'), e => e.status === 400)
    await assert.rejects(gallery.resolve('\\\\server\\share\\photo.jpg'), e => e.status === 400)
    await assert.rejects(gallery.resolve('C:/image.jpg:secret'), e => e.status === 400)
    await assert.rejects(gallery.resolve('C:/CON.jpg'), e => e.status === 400)
    await fs.symlink(path.join(fixture, 'Random folder'), path.join(fixture, 'Linked'), 'junction')
    await assert.rejects(gallery.resolve(path.join(fixture, 'Linked', 'Holiday 2026.JPG'), true), e => e.status === 403)
    assert.equal(moduleUnderTest.accessStatus(null, 'GET'), 401)
    assert.equal(moduleUnderTest.accessStatus({ isAdmin: false }, 'GET'), 403)
    assert.equal(moduleUnderTest.accessStatus({ isAdmin: true }, 'POST'), 405)
    assert.equal(moduleUnderTest.accessStatus({ isAdmin: true }, 'GET'), 200)
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(fixture).startsWith('beebo-gallery-test-'))
    await fs.rm(fixture, { recursive: true, force: true })
  }
})

test('Actual API handler: bearer authentication, live admin revocation, paging and video Range', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'beebo-gallery-test-'))
  let server
  try {
    await fs.writeFile(path.join(fixture, 'clip.mp4'), '0123456789')
    await fs.writeFile(path.join(fixture, 'secret.txt'), 'private non-media')
    const code = fss.readFileSync(path.join(appRoot, 'electron/streamServer.js'), 'utf8')
    const ast = parser.parse(code)
    const start = ast.program.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'startStreamServer')
    const handler = start.body.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'handleApiRequest')
    const data = { authUsers: [
      { id: 'owner', username: 'owner', name: 'Owner', isAdmin: true, status: 'approved' },
      { id: 'guest', username: 'guest', name: 'Guest', isAdmin: false, status: 'approved' }
    ] }
    const store = { get: k => data[k], set: (k, v) => { data[k] = v } }
    const context = {
      fs: fss, path, require: localRequire, process, Buffer, setTimeout, clearTimeout,
      __dirname: path.join(appRoot, 'electron'), auth, store, log: () => {},
      verifyApiToken: serverModule.verifyApiToken, getClientIp: () => '127.0.0.1',
      computerGalleryModule: moduleUnderTest,
      computerGallery: moduleUnderTest.createComputerGallery({ roots: async () => [fixture] }),
      apiSend: (req, res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) },
      // The content gate (parental controls / library shares) the handler consults. Nobody here
      // is limited, so it passes everything; test/parental-controls.test.js covers the gate.
      contentGate: localRequire('./electron/contentGate'),
      contentGateInstance: { isLimited: () => false, scrubJson: (v, o) => o },
      libraryShares: localRequire('./electron/libraryShares'),
      apiTokenSecret: () => 'test-secret',
      viewerForUser: () => null,
      viewerForShare: () => null,
      parentalApiGate: async () => null
    }
    vm.createContext(context)
    // Module-level constants/helpers the handler reads before it reaches the gallery routes (added to
    // streamServer after this test was written): evaluate their real declarations too.
    for (const name of ['API_LIBRARY_ROUTES', 'VIDEO_STREAM_OPTS', 'pipeFileToResponse']) {
      const decl = ast.program.body.find(n => (n.type === 'VariableDeclaration' && n.declarations.some(d => d.id && d.id.name === name)) || (n.type === 'FunctionDeclaration' && n.id && n.id.name === name))
      assert.ok(decl, name + ' is still a top-level declaration in streamServer.js')
      vm.runInContext(code.slice(decl.start, decl.end).replace(/^const /, 'var '), context)
    }
    vm.runInContext(code.slice(handler.start, handler.end), context)
    server = http.createServer((req, res) => context.handleApiRequest(req, res, new URL(req.url, 'http://localhost')))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    const owner = serverModule.makeApiToken(store, 'owner'), guest = serverModule.makeApiToken(store, 'guest')
    const request = (route, token, options = {}) => fetch(base + '/api/computer-gallery/' + route, { ...options, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers } })
    const file = 'file?rel=' + encodeURIComponent(path.join(fixture, 'clip.mp4'))
    assert.equal((await request('library')).status, 401)
    for (const route of ['library', file, file.replace('file?', 'thumb?')]) assert.equal((await request(route, guest)).status, 403)
    assert.equal((await request('library', owner, { method: 'POST' })).status, 405)
    let r = await request('library?dir=' + encodeURIComponent(fixture), owner)
    assert.equal(r.status, 200); assert.equal((await r.json()).items[0].name, 'clip.mp4')
    r = await request(file, owner, { headers: { Range: 'bytes=2-5' } })
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await r.text(), '2345')
    r = await request(file, owner, { headers: { Range: 'bytes=-3' } })
    assert.equal(r.status, 206); assert.equal(await r.text(), '789')
    assert.equal((await request(file, owner, { headers: { Range: 'bytes=99-100' } })).status, 416)
    assert.equal((await request('file?rel=' + encodeURIComponent(path.join(fixture, 'secret.txt')), owner)).status, 403)
    data.authUsers[0].isAdmin = false
    assert.equal((await request(file, owner)).status, 403)
    data.authUsers[0].status = 'revoked'
    assert.equal((await request('library', owner)).status, 401)
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(fixture).startsWith('beebo-gallery-test-'))
    await fs.rm(fixture, { recursive: true, force: true })
  }
})
