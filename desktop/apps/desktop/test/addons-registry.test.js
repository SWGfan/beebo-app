// The add-on framework (electron/addons/): manifest rules, verified downloads (checksum failure, size
// ceiling, redirects, resume), safe archive unpacking, install / uninstall / verify, disk-space check and
// progress events. "Downloads" come from a local server; nothing touches the network.
// Run: node --test test/addons-registry.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const F = require('./helpers/addonFixtures')
const { localRequire } = F
const manifestLib = localRequire('./electron/addons/manifest')
const { downloadVerified } = localRequire('./electron/addons/download')
const { extractArchive } = localRequire('./electron/addons/archive')
const { createAddonManager } = localRequire('./electron/addons')
const { SPEECH_PACK } = localRequire('./electron/addons/speechPack/manifest')
const { CATALOG } = localRequire('./electron/addons/catalog')

// ------------------------------------------------------------------- manifest
test('the built-in catalog is valid and every download is pinned: https, allowed host, sha256, exact size', () => {
  assert.deepEqual(CATALOG.map((m) => m.id), ['speech-pack'])
  const v = manifestLib.validateManifest(SPEECH_PACK)
  assert.ok(v.ok, JSON.stringify(v.problems))
  for (const c of SPEECH_PACK.components) {
    assert.match(c.sha256, /^[0-9a-f]{64}$/, c.id)
    assert.ok(c.size > 0)
    assert.match(c.url, /^https:\/\//)
    assert.ok(manifestLib.hostAllowed(new URL(c.url).hostname, SPEECH_PACK.allowedHosts), c.id)
    assert.doesNotMatch(c.url, /\/(latest|main)\//, 'no floating URLs')
    assert.ok(c.licence)
  }
  // tiny/base/small, English-focused and multilingual
  const models = SPEECH_PACK.components.filter((c) => c.group === 'model').map((c) => c.info.modelKey).sort()
  assert.deepEqual(models, ['base', 'base.en', 'small', 'small.en', 'tiny', 'tiny.en'])
  const engines = SPEECH_PACK.components.filter((c) => c.id === 'engine').map((c) => c.platform).sort()
  assert.deepEqual(engines, ['linux-x64', 'win32-x64'])
  // Licence records exist for what the manifest names.
  const dir = path.join(__dirname, '..', 'THIRD_PARTY_LICENSES')
  for (const f of SPEECH_PACK.licenceFiles) assert.ok(fs.existsSync(path.join(dir, f)), f)
})

test('validateManifest rejects http, unknown hosts, floating URLs, bad hashes and unsafe file names', () => {
  const good = F.fakeCatalog()[0]
  const with1 = (patch) => ({ ...good, components: [{ ...good.components[0], ...patch }] })
  assert.ok(manifestLib.validateManifest(good).ok)
  for (const patch of [
    { url: 'http://github.com/x.bin' },
    { url: 'https://evil.example/x.bin' },
    { url: 'https://github.com/ggml-org/whisper.cpp/releases/latest/download/x.bin' },
    { url: 'https://user:pw@github.com/x.bin' },
    { sha256: 'abc' },
    { sha256: 'A'.repeat(64) },
    { size: 0 },
    { fileName: '../evil.exe' },
    { kind: 'zip' }
  ]) assert.equal(manifestLib.validateManifest(with1(patch)).ok, false, JSON.stringify(patch))
  assert.equal(manifestLib.validateManifest({ ...good, allowedHosts: [] }).ok, false)
  assert.equal(manifestLib.validateManifest(null).ok, false)
})

test('hostAllowed: exact and *.suffix rules only', () => {
  assert.ok(manifestLib.hostAllowed('github.com', ['github.com']))
  assert.ok(manifestLib.hostAllowed('objects.githubusercontent.com', ['*.githubusercontent.com']))
  assert.equal(manifestLib.hostAllowed('githubusercontent.com', ['*.githubusercontent.com']), false)
  assert.equal(manifestLib.hostAllowed('evilgithub.com', ['github.com']), false)
  assert.equal(manifestLib.hostAllowed('github.com.evil.example', ['github.com']), false)
})

test('componentsFor picks the component for this platform (a specific platform beats any)', () => {
  const comps = manifestLib.componentsFor(SPEECH_PACK, 'win32-x64')
  assert.equal(comps.find((c) => c.id === 'engine').format, 'zip')
  assert.equal(manifestLib.componentsFor(SPEECH_PACK, 'linux-x64').find((c) => c.id === 'engine').format, 'tar.gz')
  assert.equal(manifestLib.componentsFor(SPEECH_PACK, 'darwin-arm64').some((c) => c.required), false)
})

// ------------------------------------------------------------------- download
async function dl(srv, route, body, patch = {}) {
  const dir = F.tmpDir()
  const p = {
    url: srv.base + route, sha256: F.sha256(body), size: body.length, partPath: path.join(dir, 'x.part'), destPath: path.join(dir, 'x.bin'),
    allowedHosts: ['github.com'], allowLoopbackHttp: true, ...patch
  }
  return { dir, p, run: () => downloadVerified(p) }
}

test('download: a good file passes, lands at destPath, and reports progress', async () => {
  const body = Buffer.alloc(200000, 7)
  const srv = await F.startFileServer({ '/a.bin': body })
  try {
    const seen = []
    const t = await dl(srv, '/a.bin', body, { onProgress: (x) => seen.push(x.received) })
    const r = await t.run()
    assert.equal(r.bytes, body.length)
    assert.deepEqual(fs.readFileSync(t.p.destPath), body)
    assert.ok(!fs.existsSync(t.p.partPath))
    assert.equal(seen[seen.length - 1], body.length)
  } finally { await srv.close() }
})

test('download: a WRONG CHECKSUM is rejected, discarded, and never reaches destPath', async () => {
  const body = Buffer.alloc(5000, 1)
  const srv = await F.startFileServer({ '/a.bin': body })
  try {
    const t = await dl(srv, '/a.bin', body, { sha256: F.sha256(Buffer.from('something else')) })
    await assert.rejects(t.run(), (e) => e.code === 'checksum_mismatch')
    assert.ok(!fs.existsSync(t.p.destPath))
    assert.ok(!fs.existsSync(t.p.partPath), 'the bad partial file is deleted')
  } finally { await srv.close() }
})

test('download: more data than the pinned size is aborted (cannot fill the disk), less fails', async () => {
  const body = Buffer.alloc(4000, 2)
  const srv = await F.startFileServer({ '/big.bin': { body: Buffer.alloc(9000, 2), lengthHeader: undefined }, '/short.bin': { body, cutAfter: 1000, lengthHeader: 4000 } })
  try {
    let t = await dl(srv, '/big.bin', body)
    await assert.rejects(t.run(), (e) => e.code === 'size_mismatch')
    assert.ok(!fs.existsSync(t.p.destPath))
    t = await dl(srv, '/short.bin', body)
    await assert.rejects(t.run(), (e) => ['network', 'size_mismatch'].includes(e.code))
    assert.ok(!fs.existsSync(t.p.destPath))
  } finally { await srv.close() }
})

test('download: https only, allowlisted hosts only (also across redirects), redirect limit', async () => {
  const body = Buffer.from('payload')
  const srv = await F.startFileServer({ '/a.bin': body })
  try {
    let t = await dl(srv, '/a.bin', body, { url: 'http://example.com/a.bin', allowLoopbackHttp: false })
    await assert.rejects(t.run(), (e) => e.code === 'insecure_url')
    t = await dl(srv, '/a.bin', body, { url: 'https://evil.example/a.bin' })
    await assert.rejects(t.run(), (e) => e.code === 'host_not_allowed')
    // plain http to a non-loopback host stays refused even when the test flag is on
    t = await dl(srv, '/a.bin', body, { url: 'http://10.0.0.5/a.bin' })
    await assert.rejects(t.run(), (e) => e.code === 'insecure_url')
    // a redirect to a host that is not allowed is refused
    const s2 = await F.startFileServer({ '/r': { redirect: 'https://evil.example/a.bin' }, '/loop': { redirect: '/loop' } })
    try {
      t = await dl(s2, '/r', body)
      await assert.rejects(t.run(), (e) => e.code === 'host_not_allowed')
      t = await dl(s2, '/loop', body)
      await assert.rejects(t.run(), (e) => e.code === 'too_many_redirects')
    } finally { await s2.close() }
    // a redirect that stays on loopback (standing in for an allowed CDN) works
    const s3 = await F.startFileServer({ '/a': { redirect: srv.base + '/a.bin' } })
    try {
      t = await dl(s3, '/a', body)
      assert.equal((await t.run()).bytes, body.length)
    } finally { await s3.close() }
  } finally { await srv.close() }
})

test('download: an HTTP error status fails; cancel aborts and keeps the partial file for resuming', async () => {
  const body = Buffer.alloc(300000, 3)
  const srv = await F.startFileServer({ '/a.bin': body, '/e': { body: Buffer.from('x'), status: 500 } })
  try {
    let t = await dl(srv, '/e', body)
    await assert.rejects(t.run(), (e) => e.code === 'http_error')
    const ac = new AbortController()
    t = await dl(srv, '/a.bin', body, { signal: ac.signal, onProgress: () => ac.abort() })
    await assert.rejects(t.run(), (e) => e.code === 'cancelled')
    assert.ok(!fs.existsSync(t.p.destPath))
  } finally { await srv.close() }
})

test('download: an interrupted file resumes with a Range request and still verifies', async () => {
  const body = Buffer.from(Array.from({ length: 50000 }, (_, i) => i % 251))
  const srv = await F.startFileServer({ '/a.bin': body })
  try {
    const t = await dl(srv, '/a.bin', body)
    fs.writeFileSync(t.p.partPath, body.subarray(0, 20000)) // what an earlier attempt left
    const r = await t.run()
    assert.equal(r.resumedFrom, 20000)
    assert.deepEqual(fs.readFileSync(t.p.destPath), body)
    assert.equal(srv.hits.at(-1).range, 'bytes=20000-')
    // a server that ignores Range restarts the file and still verifies
    const srv2 = await F.startFileServer({ '/a.bin': body }, { ignoreRange: true })
    try {
      const t2 = await dl(srv2, '/a.bin', body)
      fs.writeFileSync(t2.p.partPath, body.subarray(0, 100))
      assert.equal((await t2.run()).resumedFrom, 0)
      assert.deepEqual(fs.readFileSync(t2.p.destPath), body)
    } finally { await srv2.close() }
    // a corrupt partial file is caught by the final checksum, not trusted
    const t3 = await dl(srv, '/a.bin', body)
    fs.writeFileSync(t3.p.partPath, Buffer.alloc(20000, 9))
    await assert.rejects(t3.run(), (e) => e.code === 'checksum_mismatch')
  } finally { await srv.close() }
})

// -------------------------------------------------------------------- archives
const PATTERNS = ['whisper-cli.exe', '*.dll']
test('zip: only allowlisted names are extracted, flat, with hashes; the rest is ignored', () => {
  const dir = F.tmpDir()
  const zip = F.buildZip([
    { name: 'Release/whisper-cli.exe', data: 'EXE' },
    { name: 'Release/ggml.dll', data: 'DLL', method: 0 },
    { name: 'Release/stream.exe', data: 'NOPE' },
    { name: 'Release/', data: '' }
  ])
  fs.writeFileSync(path.join(dir, 'a.zip'), zip)
  const out = extractArchive({ file: path.join(dir, 'a.zip'), format: 'zip', patterns: PATTERNS, executable: 'whisper-cli.exe', destDir: path.join(dir, 'o'), unpackedMaxBytes: 1000 })
  assert.deepEqual(out.map((f) => f.name).sort(), ['ggml.dll', 'whisper-cli.exe'])
  assert.equal(fs.readFileSync(path.join(dir, 'o', 'whisper-cli.exe'), 'utf8'), 'EXE')
  assert.equal(out.find((f) => f.name === 'ggml.dll').sha256, F.sha256(Buffer.from('DLL')))
  assert.ok(!fs.existsSync(path.join(dir, 'o', 'stream.exe')))
})

test('zip: path traversal, a missing executable, damage and bombs are refused', () => {
  const dir = F.tmpDir()
  const run = (entries, patch = {}) => {
    fs.writeFileSync(path.join(dir, 'a.zip'), F.buildZip(entries))
    return () => extractArchive({ file: path.join(dir, 'a.zip'), format: 'zip', patterns: PATTERNS, executable: 'whisper-cli.exe', destDir: path.join(dir, 'o' + Math.random()), unpackedMaxBytes: 1000, ...patch })
  }
  assert.throws(run([{ name: '../evil.dll', data: 'x' }, { name: 'whisper-cli.exe', data: 'x' }]), (e) => e.code === 'extract_failed')
  assert.throws(run([{ name: '/abs/evil.dll', data: 'x' }]), (e) => e.code === 'extract_failed')
  assert.throws(run([{ name: 'C:\\evil.dll', data: 'x' }]), (e) => e.code === 'extract_failed')
  assert.throws(run([{ name: 'ggml.dll', data: 'x' }]), /does not contain whisper-cli\.exe/)
  assert.throws(run([{ name: 'whisper-cli.exe', data: 'x', badCrc: true }]), (e) => e.code === 'extract_failed')
  assert.throws(run([{ name: 'whisper-cli.exe', data: 'A'.repeat(5000) }]), /more than expected/)
  fs.writeFileSync(path.join(dir, 'junk.zip'), Buffer.from('not a zip at all'))
  assert.throws(() => extractArchive({ file: path.join(dir, 'junk.zip'), format: 'zip', patterns: PATTERNS, executable: 'x', destDir: path.join(dir, 'z'), unpackedMaxBytes: 10 }), (e) => e.code === 'extract_failed')
})

test('tar.gz: regular files and in-archive symlinks become real files; other links are ignored', () => {
  const dir = F.tmpDir()
  const tgz = F.buildTarGz([
    { name: 'build/bin/whisper-cli', data: 'ELF' },
    { name: 'build/lib/libwhisper.so.1.9.2', data: 'SO' },
    { name: 'build/lib/libwhisper.so.1', type: '2', link: 'libwhisper.so.1.9.2' },
    { name: 'build/lib/libwhisper.so', type: '2', link: 'libwhisper.so.1' },
    { name: 'build/lib/libevil.so', type: '2', link: '/etc/passwd' },
    { name: 'build/bin/bench', data: 'NO' }
  ])
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), tgz)
  const out = extractArchive({ file: path.join(dir, 'a.tar.gz'), format: 'tar.gz', patterns: ['whisper-cli', '*.so', '*.so.*'], executable: 'whisper-cli', destDir: path.join(dir, 'o'), unpackedMaxBytes: 1000 })
  assert.deepEqual(out.map((f) => f.name).sort(), ['libwhisper.so', 'libwhisper.so.1', 'libwhisper.so.1.9.2', 'whisper-cli'])
  assert.equal(fs.readFileSync(path.join(dir, 'o', 'libwhisper.so'), 'utf8'), 'SO')
  assert.ok(!fs.existsSync(path.join(dir, 'o', 'libevil.so')))
  assert.throws(() => extractArchive({ file: path.join(dir, 'a.tar.gz'), format: 'tar.gz', patterns: ['whisper-cli', '*.so*'], executable: 'whisper-cli', destDir: path.join(dir, 'o2'), unpackedMaxBytes: 3 }), /more than expected/)
})

// -------------------------------------------------------- install / uninstall
test('install: downloads, verifies, records hashes, reports progress; required + chosen components only', async () => {
  const { manager, srv } = await F.fakeSpeechManager()
  try {
    const events = []
    manager.on('progress', (e) => events.push(e))
    assert.equal(manager.get('speech-pack').installed, false)
    const r = await manager.install('speech-pack', { components: ['model-base.en'] })
    assert.deepEqual(r, { ok: true, installed: ['engine', 'model-base.en'], skipped: [] })
    const info = manager.get('speech-pack')
    assert.equal(info.installed, true)
    assert.equal(info.components.find((c) => c.id === 'model-base.en').installed, true)
    assert.equal(info.components.find((c) => c.id === 'model-base').installed, false, 'unchosen models are not downloaded')
    assert.ok(events.some((e) => e.phase === 'downloading' && e.percent === 100))
    assert.equal(events.at(-1).phase, 'done')
    assert.ok(!fs.existsSync(path.join(manager.dir, '.tmp')) || fs.readdirSync(path.join(manager.dir, '.tmp')).length === 0, 'staging is cleaned up')
    const ok = await manager.resolve('speech-pack', 'model-base.en')
    assert.equal(fs.readFileSync(ok.file, 'utf8'), 'fake-model base.en')
    // installing again skips what is already there
    const again = await manager.install('speech-pack', { components: ['model-base.en'] })
    assert.deepEqual(again, { ok: true, installed: [], skipped: ['engine', 'model-base.en'] })
    // a second model later only downloads that model
    const more = await manager.install('speech-pack', { components: ['model-base'] })
    assert.deepEqual(more.installed, ['model-base'])
  } finally { await srv.close() }
})

test('install: a checksum failure installs NOTHING and leaves no files behind', async () => {
  const { manager, srv, dir } = await F.fakeSpeechManager({ extraRoutes: { '/whisper-cli.exe': Buffer.from('tampered engine!!') } })
  try {
    // the served bytes differ from the pinned hash (and have the same length: only the checksum can catch it)
    const events = []
    manager.on('progress', (e) => events.push(e))
    const r = await manager.install('speech-pack', {})
    assert.equal(r.ok, false)
    assert.ok(['checksum_mismatch', 'size_mismatch'].includes(r.error), r.error)
    assert.equal(manager.get('speech-pack').installed, false)
    assert.ok(!fs.existsSync(path.join(dir, 'speech-pack', 'engine')))
    assert.ok(!fs.existsSync(path.join(dir, 'speech-pack', 'state.json')))
    assert.equal(events.at(-1).phase, 'error')
    await assert.rejects(manager.resolve('speech-pack', 'engine'), (e) => e.code === 'not_installed')
  } finally { await srv.close() }
})

test('install: same-size tampering is caught by the SHA-256 (not just the size)', async () => {
  const good = F.ENGINE_BYTES
  const evil = Buffer.from(good.toString().replace('fake', 'EVIL'))
  assert.equal(evil.length, good.length)
  const { manager, srv } = await F.fakeSpeechManager({ extraRoutes: { '/whisper-cli.exe': evil } })
  try {
    const r = await manager.install('speech-pack', {})
    assert.equal(r.error, 'checksum_mismatch')
  } finally { await srv.close() }
})

test('install: not enough disk space is refused before anything is downloaded', async () => {
  const { srv, catalog, dir } = await F.fakeSpeechManager()
  const m = createAddonManager({ dir, catalog, platform: 'win32-x64', freeBytes: () => 1024 })
  try {
    const r = await m.install('speech-pack', {})
    assert.equal(r.ok, false)
    assert.equal(r.error, 'not_enough_space')
    assert.match(r.message, /free/)
    assert.equal(srv.hits.length, 0, 'no download was started')
  } finally { await srv.close() }
})

test('install: unknown add-on / component / platform are refused; only one install at a time', async () => {
  const { manager, srv, dir, catalog } = await F.fakeSpeechManager()
  try {
    assert.equal((await manager.install('nope')).error, 'unknown_addon')
    assert.equal((await manager.install('speech-pack', { components: ['model-huge'] })).error, 'bad_component')
    const other = createAddonManager({ dir: F.tmpDir(), catalog: [SPEECH_PACK], platform: 'freebsd-x64' })
    assert.equal(other.get('speech-pack').supported, false)
    assert.equal((await other.install('speech-pack')).error, 'unsupported_platform')
    const [a, b] = await Promise.all([manager.install('speech-pack', {}), manager.install('speech-pack', {})])
    assert.deepEqual([a.ok, b.ok].sort(), [false, true])
    assert.equal([a, b].find((x) => !x.ok).error, 'busy')
  } finally { await srv.close() }
})

test('cancel: stops an install in progress and a later install completes', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 5)
  const catalog = F.fakeCatalog()
  catalog[0].components[0] = { ...catalog[0].components[0], size: big.length, sha256: F.sha256(big) }
  const srv = await F.startFileServer({ '/whisper-cli.exe': big })
  const { downloadVerified: dv } = { downloadVerified }
  const m = createAddonManager({ dir: F.tmpDir(), catalog, platform: 'win32-x64', download: (o) => dv({ ...o, url: srv.base + '/whisper-cli.exe', allowLoopbackHttp: true }) })
  try {
    m.on('progress', (e) => { if (e.phase === 'downloading' && e.received > 0) m.cancel('speech-pack') })
    const r = await m.install('speech-pack', {})
    assert.equal(r.error, 'cancelled')
    assert.equal(m.get('speech-pack').installed, false)
    assert.deepEqual(m.cancel('speech-pack'), { ok: false, error: 'not_running' })
  } finally { await srv.close() }
})

test('uninstall: removes components (or everything), keeps data unless purged, notifies listeners first', async () => {
  const { manager, srv, dir } = await F.fakeSpeechManager()
  try {
    await manager.install('speech-pack', { components: ['model-base.en', 'model-base'] })
    manager.dataDir('speech-pack')
    fs.writeFileSync(path.join(manager.dataDir('speech-pack'), 'keep.txt'), 'x')
    const order = []
    manager.onBeforeUninstall(async (id, ids) => { order.push(['before', id, ids.slice().sort()]) })
    manager.on('uninstalled', (e) => order.push(['after', e.id]))
    const one = await manager.uninstall('speech-pack', { components: ['model-base'] })
    assert.deepEqual(one.removed, ['model-base'])
    assert.equal(manager.get('speech-pack').components.find((c) => c.id === 'model-base').installed, false)
    assert.equal(manager.get('speech-pack').installed, true, 'the engine and the other model stay')
    const all = await manager.uninstall('speech-pack', {})
    assert.deepEqual(all.removed.sort(), ['engine', 'model-base.en'])
    assert.equal(manager.get('speech-pack').installed, false)
    assert.ok(!fs.existsSync(path.join(dir, 'speech-pack', 'engine')))
    assert.ok(fs.existsSync(path.join(dir, 'speech-pack', 'data', 'keep.txt')), 'add-on data survives an uninstall')
    assert.equal(order[0][0], 'before')
    await manager.uninstall('speech-pack', { purge: true })
    assert.ok(!fs.existsSync(path.join(dir, 'speech-pack')))
    // and it can be installed again
    assert.equal((await manager.install('speech-pack', {})).ok, true)
  } finally { await srv.close() }
})

test('verify / resolve: a modified or deleted file is detected; a resolve gates every use', async () => {
  const { manager, srv, dir } = await F.fakeSpeechManager()
  try {
    await manager.install('speech-pack', { components: ['model-base.en'] })
    assert.deepEqual((await manager.verify('speech-pack')).ok, true)
    const eng = path.join(dir, 'speech-pack', 'engine', 'whisper-cli.exe')
    fs.writeFileSync(eng, Buffer.from('fake whisper engine bXnary')) // same length, different bytes
    const v = await manager.verify('speech-pack')
    assert.equal(v.ok, false)
    assert.deepEqual(v.components.find((c) => c.id === 'engine').problems, [{ file: 'whisper-cli.exe', problem: 'modified' }])
    await assert.rejects(manager.resolve('speech-pack', 'engine'), (e) => e.code === 'corrupt')
    fs.rmSync(eng)
    assert.equal(manager.get('speech-pack').installed, false, 'a missing program counts as not installed')
    await assert.rejects(manager.resolve('speech-pack', 'engine'), (e) => e.code === 'not_installed')
    // repair = install again
    assert.equal((await manager.install('speech-pack', {})).ok, true)
    assert.ok((await manager.resolve('speech-pack', 'engine')).file.endsWith('whisper-cli.exe'))
  } finally { await srv.close() }
})

test('a manifest that fails validation is ignored, not offered', () => {
  const bad = { ...F.fakeCatalog()[0], id: 'Bad Id' }
  const m = createAddonManager({ dir: F.tmpDir(), catalog: [bad, F.fakeCatalog()[0]] })
  assert.deepEqual(m.list().map((a) => a.id), ['speech-pack'])
  assert.equal(m.problems.length, 1)
})
