'use strict'
// The decision "may this update be installed?" and the wiring of it inside desktopUpdater.js.
// Everything that could touch the machine (network, filesystem installer, PowerShell, the
// watchdog marker) is replaced by fakes: no installer is ever run.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-updater-'))
const realProgramData = process.env.ProgramData
process.env.ProgramData = sandbox // the watchdog marker goes here, not to the real machine
const quits = []
const shown = []
const electronStub = {
  app: { getPath: () => sandbox, getVersion: () => '0.1.57', isPackaged: true, quit: () => quits.push(Date.now()) },
  dialog: { showMessageBox: (...a) => shown.push(a) },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  shell: { showItemInFolder: () => {} }
}
require.cache[require.resolve('electron')] = { id: 'electron', filename: require.resolve('electron'), loaded: true, exports: electronStub }

const trust = require('../electron/updateTrust')
const updater = require('../electron/desktopUpdater')
const T = updater.__test

const SHA = 'a'.repeat(64)
const goodInfo = (over) => Object.assign({ version: '0.1.58', url: 'https://beeboentertainment.com/dl/setup-0.1.58.exe', sha256: SHA, size: 1000, notes: 'n' }, over)

function fakes() {
  const calls = { download: [], elevated: [], shown: [] }
  let downloadResult = (opts) => ({ path: opts.dest, sha256: opts.expectedSha256, bytes: 1000, resumedFrom: 0 })
  T.impl.downloadResumable = async (opts) => { calls.download.push(opts); return downloadResult(opts) }
  T.impl.startElevated = async (exe, args) => { calls.elevated.push({ exe, args }); return { ok: true, pid: 1234 } }
  T.impl.exists = () => true
  T.impl.platform = () => 'win32' // the updater is Windows-only; act as Windows so this runs on Linux CI too
  T.impl.showItem = (p) => calls.shown.push(p)
  return { calls, setDownloadResult: (fn) => { downloadResult = fn } }
}
const store = () => { const d = {}; return { get: (k) => d[k], set: (k, v) => { d[k] = v }, delete: (k) => { delete d[k] }, d } }

test.beforeEach(() => { T.reset(); updater.bindPrefStore(store()) })
test.after(() => { if (realProgramData === undefined) delete process.env.ProgramData; else process.env.ProgramData = realProgramData })

// ---- the pure decision ---------------------------------------------------------
test('evaluateFeed: only a complete, https, fingerprinted feed is installable', () => {
  assert.deepEqual(trust.evaluateFeed(goodInfo()), { ok: true, sha256: SHA, reason: '', downloadOnlyPossible: false })
  assert.equal(trust.evaluateFeed(goodInfo({ sha256: SHA.toUpperCase() })).sha256, SHA, 'case does not matter')
  assert.equal(trust.evaluateFeed(goodInfo({ sha256: '  ' + SHA + '\n' })).ok, true, 'whitespace does not matter')
  for (const bad of [undefined, null, '', '   ', 'abc', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 123, {}, [SHA]]) {
    const r = trust.evaluateFeed(goodInfo({ sha256: bad }))
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.equal(r.reason, 'no-fingerprint', JSON.stringify(bad))
    assert.equal(r.downloadOnlyPossible, true)
  }
  assert.equal(trust.evaluateFeed(goodInfo({ url: 'http://beeboentertainment.com/x.exe' })).reason, 'insecure-url')
  assert.equal(trust.evaluateFeed(goodInfo({ url: 'ftp://x/y' })).ok, false)
  assert.equal(trust.evaluateFeed(goodInfo({ url: 'not a url' })).ok, false)
  assert.equal(trust.evaluateFeed(goodInfo({ url: '' })).reason, 'feed-incomplete')
  assert.equal(trust.evaluateFeed({ url: 'https://x/y.exe', sha256: SHA }).reason, 'feed-incomplete')
  assert.equal(trust.evaluateFeed(null).downloadOnlyPossible, false)
  assert.equal(trust.evaluateFeed(goodInfo({ url: 'http://x/y.exe', sha256: '' })).downloadOnlyPossible, false, 'an insecure address is never even downloaded')
})

test('installGate: verified download only', () => {
  assert.equal(trust.installGate({ info: goodInfo(), verified: true }).ok, true)
  assert.equal(trust.installGate({ info: goodInfo(), verified: false }).reason, 'not-verified')
  assert.equal(trust.installGate({ info: goodInfo(), verified: undefined }).reason, 'not-verified')
  assert.equal(trust.installGate({ info: goodInfo({ sha256: '' }), verified: true }).reason, 'no-fingerprint')
  assert.equal(trust.installGate({ info: goodInfo(), verified: true, downloadOnly: true }).reason, 'download-only')
  assert.equal(trust.installGate(null).ok, false)
})

// ---- the wiring -----------------------------------------------------------------
test('a feed without sha256 is refused: nothing is downloaded and no installer starts', async () => {
  const f = fakes()
  const p = await updater.startDownload(goodInfo({ sha256: undefined }), { then: 'now' })
  assert.equal(f.calls.download.length, 0)
  assert.equal(f.calls.elevated.length, 0)
  assert.equal(p.phase, 'error')
  assert.equal(p.errorKind, 'nosha')
  assert.equal(p.canDownloadOnly, true)
  assert.match(p.message, /no security fingerprint/)
  assert.match(p.message, /Nothing was changed/)
})

test('an insecure or incomplete feed is refused, and "download only" cannot override that', async () => {
  const f = fakes()
  for (const info of [goodInfo({ url: 'http://example.com/x.exe' }), goodInfo({ url: '' })]) {
    T.reset()
    const p = await updater.startDownload(info, { allowUnverified: true })
    assert.equal(p.phase, 'error')
    assert.equal(p.errorKind, 'feed')
    assert.equal(p.canDownloadOnly, false)
  }
  assert.equal(f.calls.download.length, 0)
})

test('the owner\'s "download only" saves the file but never installs, even if an install was requested', async () => {
  const f = fakes()
  f.setDownloadResult((opts) => ({ path: opts.dest, sha256: 'b'.repeat(64), bytes: 1000, resumedFrom: 0 }))
  const p = await updater.startDownload(goodInfo({ sha256: '' }), { allowUnverified: true, then: 'now' })
  assert.equal(f.calls.download.length, 1)
  assert.equal(f.calls.download[0].expectedSha256, '', 'nothing to verify against, and the panel says so')
  assert.equal(p.phase, 'ready')
  assert.equal(p.verified, false)
  assert.equal(p.installBlocked, true)
  assert.match(p.savedTo, /BeeboEntertainmentSetup-0\.1\.58\.exe$/)
  assert.match(p.message, /won’t run it for you/)
  const after = await updater.launchInstall()
  assert.equal(f.calls.elevated.length, 0)
  assert.equal(after.installBlocked, true)
  updater.scheduleInstall('now')
  await new Promise((r) => setImmediate(r))
  assert.equal(f.calls.elevated.length, 0, 'scheduleInstall cannot get around it either')
})

test('a fingerprinted update downloads with the normalised fingerprint, is verified, and installs', async () => {
  const f = fakes()
  const p = await updater.startDownload(goodInfo({ sha256: SHA.toUpperCase() }), { then: 'now' })
  assert.equal(f.calls.download[0].expectedSha256, SHA)
  assert.equal(p.verified, true)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.calls.elevated.length, 1)
  assert.deepEqual(f.calls.elevated[0].args.slice(0, 2), ['--updated', '--force-run'])
  assert.match(f.calls.elevated[0].exe, /BeeboEntertainmentSetup-0\.1\.58\.exe$/)
  assert.equal(T.progress().phase, 'installing')
})

test('the installer refuses at the last moment if the state was tampered with (no fingerprint, or not verified)', async () => {
  const f = fakes()
  T.setJob({ version: '0.1.58', info: goodInfo({ sha256: '' }), dest: path.join(sandbox, 'x.exe'), ready: true, verified: true, estimator: {} })
  let p = await updater.launchInstall()
  assert.equal(p.phase, 'error')
  assert.equal(p.errorKind, 'nosha')
  T.reset()
  T.setJob({ version: '0.1.58', info: goodInfo(), dest: path.join(sandbox, 'x.exe'), ready: true, verified: false, estimator: {} })
  p = await updater.launchInstall()
  assert.equal(p.phase, 'error')
  assert.match(p.message, /not checked against its security fingerprint/)
  assert.equal(f.calls.elevated.length, 0)
})

test('a download that fails its fingerprint check installs nothing and says why', async () => {
  const f = fakes()
  f.setDownloadResult(() => { const e = new Error('mismatch'); e.code = 'SHA_MISMATCH'; throw e })
  const p = await updater.startDownload(goodInfo(), { then: 'now' })
  assert.equal(p.phase, 'error')
  assert.equal(p.errorKind, 'sha')
  assert.equal(f.calls.elevated.length, 0)
})

test('a download that lands with a different hash than the feed is not treated as verified', async () => {
  const f = fakes()
  f.setDownloadResult((opts) => ({ path: opts.dest, sha256: 'c'.repeat(64), bytes: 1, resumedFrom: 0 }))
  await updater.startDownload(goodInfo(), { then: 'now' })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.calls.elevated.length, 0)
  assert.equal(T.progress().phase, 'error')
})

test('when the feed later gains a fingerprint, an earlier download-only state does not linger', async () => {
  const f = fakes()
  await updater.startDownload(goodInfo({ sha256: '' }), { allowUnverified: true })
  const p = await updater.startDownload(goodInfo(), { then: 'now' })
  assert.equal(p.installBlocked, false)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(f.calls.elevated.length, 1)
})

test('status check reports installable / not installable so the panel can warn early', async () => {
  fakes()
  T.impl.fetchJson = async () => goodInfo({ sha256: undefined })
  let st = await updater.fetchUpdateStatus()
  assert.equal(st.available, true)
  assert.equal(st.installable, false)
  assert.equal(st.notInstallableReason, 'no-fingerprint')
  T.impl.fetchJson = async () => goodInfo()
  st = await updater.fetchUpdateStatus()
  assert.equal(st.installable, true)
})

test('off Windows the updater stands down: no feed is fetched and nothing is offered', async () => {
  fakes()
  let fetched = 0
  T.impl.fetchJson = async () => { fetched++; return goodInfo() }
  T.impl.platform = () => 'linux'
  const st = await updater.fetchUpdateStatus()
  assert.equal(st.supported, false)
  assert.equal(st.available, false)
  assert.equal(fetched, 0)
})
