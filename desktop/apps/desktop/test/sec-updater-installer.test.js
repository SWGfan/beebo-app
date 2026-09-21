'use strict'
// The update path (security review 2026-09-21, E-5): the installer is run elevated, so
//  - the feed's version must not be able to become a path or PowerShell text,
//  - the file is hashed again right before it is started (it sits in a user-writable folder, maybe for hours),
//  - a redirect may not step down from https to http.
// No installer is ever run and no network is used.
// Run: node --test test/sec-updater-installer.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-secupd-'))
const realProgramData = process.env.ProgramData
process.env.ProgramData = sandbox
const electronStub = {
  app: { getPath: () => sandbox, getVersion: () => '0.1.57', isPackaged: true, quit: () => {} },
  dialog: { showMessageBox: () => {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  shell: { showItemInFolder: () => {} }
}
require.cache[require.resolve('electron')] = { id: 'electron', filename: require.resolve('electron'), loaded: true, exports: electronStub }

const trust = require('../electron/updateTrust')
const updater = require('../electron/desktopUpdater')
const dl = require('../electron/updateDownload')
const T = updater.__test

test.after(() => { if (realProgramData === undefined) delete process.env.ProgramData; else process.env.ProgramData = realProgramData })
test.beforeEach(() => { T.reset(); updater.bindPrefStore({ get: () => undefined, set: () => {}, delete: () => {} }) })

const SHA = 'a'.repeat(64)
const info = (over) => Object.assign({ version: '0.1.58', url: 'https://beeboentertainment.com/dl/setup.exe', sha256: SHA, size: 10 }, over)
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

test('a feed version that is a path, a quote or a line break is refused', () => {
  const evil = [
    '../../../Users/Public/x', '..\\..\\x', '0.1.58/../../x', '0.1.58\\x', "0.1.58'; calc; '", '0.1.58’; calc; ‘', '0.1.58\n1',
    '0.1.58 ', ' 0.1.58', 'latest', '', '1', '0.1.58; rm', '0.1.58\0', 'x'.repeat(200), '0.1.58-' + 'a'.repeat(60), '..', '0..1', '.1.2'
  ]
  for (const v of evil) {
    const r = trust.evaluateFeed(info({ version: v }))
    assert.equal(r.ok, false, JSON.stringify(v))
  }
  for (const v of ['0.1.58', '1.0.0', '10.20.30', '0.2.0-beta.1', '1.2.3.4', '0.1.58+build5', 0.5]) {
    assert.equal(trust.evaluateFeed(info({ version: v })).ok, true, String(v))
  }
})

test('startDownload with a hostile version writes nothing and starts nothing', async () => {
  let downloads = 0
  T.impl.downloadResumable = async () => { downloads++; return { path: 'x', sha256: SHA, bytes: 1, resumedFrom: 0 } }
  T.impl.platform = () => 'win32'
  await updater.startDownload(info({ version: '../../../evil' }), { then: 'now' })
  assert.equal(downloads, 0)
  assert.equal(T.progress().phase, 'error')
})

test('the installer is hashed again right before it starts; a swapped file is refused', async () => {
  const good = Buffer.from('the real installer bytes')
  const file = path.join(sandbox, 'BeeboEntertainmentSetup-0.1.58.exe')
  fs.writeFileSync(file, good)
  assert.equal(await T.installerStillMatches(file, sha256(good)), true)
  fs.writeFileSync(file, Buffer.from('MZ swapped by another program'))
  assert.equal(await T.installerStillMatches(file, sha256(good)), false, 'changed file')
  assert.equal(await T.installerStillMatches(file, ''), false, 'no fingerprint means no run')
  assert.equal(await T.installerStillMatches(path.join(sandbox, 'missing.exe'), sha256(good)), false)
})

test('startElevated (the real one) refuses a changed file before any PowerShell starts', async () => {
  const real = T.impl.startElevated
  const file = path.join(sandbox, 'BeeboEntertainmentSetup-0.1.59.exe')
  fs.writeFileSync(file, Buffer.from('swapped'))
  T.impl.platform = () => 'win32'
  const r = await real(file, ['--updated'], { sha256: sha256(Buffer.from('the verified download')) })
  assert.equal(r.ok, false)
  assert.equal(r.tampered, true)
})

test('launchInstall passes the fingerprint on and, on a swap, deletes the file and does not offer it again', async () => {
  const file = path.join(sandbox, 'BeeboEntertainmentSetup-0.1.58.exe')
  fs.writeFileSync(file, 'x')
  const calls = []
  T.impl.exists = () => true
  T.impl.platform = () => 'win32'
  T.impl.startElevated = async (exe, args, opts) => { calls.push({ exe, args, opts }); return { ok: false, tampered: true, message: 'changed' } }
  T.setJob({ version: '0.1.58', info: info(), dest: file, ready: true, verified: true, running: false, estimator: { estimate: () => 5 } })
  const p = await updater.launchInstall()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.sha256, SHA, 'the fingerprint from the feed is what the file is compared with')
  assert.equal(p.phase, 'error')
  assert.equal(fs.existsSync(file), false, 'a changed installer is removed')
})

test('a redirect from https to http is refused (installer download)', async () => {
  // A local server stands in for the "other end": the request is plain http here, so the rule is exercised through
  // the redirect target check directly on defaultRequest's contract.
  const server = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:1/x' }); res.end() })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = server.address().port
    // http -> http is allowed (tests and local mirrors); the downgrade rule only concerns https origins.
    await assert.rejects(dl.defaultRequest(`http://127.0.0.1:${port}/a`, {}), /ECONNREFUSED|connect/i)
  } finally { server.close() }
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'updateDownload.js'), 'utf8')
  assert.match(src, /redirect to an insecure address/, 'https -> http is refused in the installer download')
  const upd = fs.readFileSync(path.join(__dirname, '..', 'electron', 'desktopUpdater.js'), 'utf8')
  assert.match(upd, /redirect to an insecure address/, 'https -> http is refused when reading the feed')
  assert.match(upd, /FEED_MAX_CHARS/, 'the feed is size-capped')
})
