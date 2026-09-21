// Headless server: the `electron` stand-in and its safeStorage replacement.
// Run: node --test test/headless-electron-shim.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createElectronShim } = require(path.join(__dirname, '..', 'headless', 'electronShim.js'))
const secretBox = require(path.join(__dirname, '..', 'headless', 'secretBox.js'))

const POSIX = process.platform !== 'win32'

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-shim-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeShim(t, overrides = {}) {
  const dataDir = tmp(t)
  const logs = []
  const quits = []
  const safeStorage = secretBox.createSafeStorage(Buffer.alloc(32, 7))
  const shim = createElectronShim(Object.assign({ dataDir, appDir: path.join(dataDir, 'app'), version: '9.8.7', safeStorage, log: (m) => logs.push(m), onQuit: (c) => quits.push(c), env: { LANG: 'de_DE.UTF-8' } }, overrides))
  return { shim, dataDir, logs, quits, safeStorage }
}

test('app paths, version, packaging and locale', (t) => {
  const { shim, dataDir } = makeShim(t)
  assert.equal(shim.app.getPath('userData'), dataDir)
  assert.equal(shim.app.getPath('temp'), os.tmpdir())
  assert.equal(shim.app.getVersion(), '9.8.7')
  assert.equal(shim.app.isPackaged, true)
  assert.equal(shim.app.getLocale(), 'de-DE')
  assert.throws(() => shim.app.getPath('nonsense'), /Failed to get 'nonsense' path/)
  assert.equal(shim.app.requestSingleInstanceLock(), true)
  assert.equal(shim.app.getAppMetrics()[0].memory.workingSetSize > 0, true)
})

test('whenReady resolves and unknown app methods are inert, not crashes', async (t) => {
  const { shim } = makeShim(t)
  await shim.app.whenReady()
  assert.equal(shim.app.someFutureElectronCall('x'), undefined)
  assert.equal(shim.app.isReady(), true)
})

test('quit runs before-quit handlers, honours preventDefault, then exits once', (t) => {
  const { shim, quits } = makeShim(t)
  let calls = 0
  shim.app.on('before-quit', (e) => {
    calls += 1
    if (calls === 1) e.preventDefault()
  })
  shim.app.quit()
  assert.equal(calls, 1)
  assert.deepEqual(quits, [])
  shim.app.quit()
  assert.equal(calls, 2)
  assert.deepEqual(quits, [0])
  shim.app.quit()
  assert.deepEqual(quits, [0])
})

test('windows, tray, menu, notifications are inert and nothing is shown', (t) => {
  const { shim } = makeShim(t)
  const win = new shim.BrowserWindow({ width: 10 })
  win.loadURL('http://x')
  win.on('close', () => {})
  assert.equal(win.isDestroyed(), true)
  assert.deepEqual(shim.BrowserWindow.getAllWindows(), [])
  const tray = new shim.Tray(shim.nativeImage.createFromPath('x.ico'))
  tray.setContextMenu(shim.Menu.buildFromTemplate([]))
  assert.equal(shim.Notification.isSupported(), false)
})

test('dialogs answer cancelled and openExternal never opens a browser', async (t) => {
  const { shim, logs } = makeShim(t)
  assert.deepEqual(await shim.dialog.showOpenDialog({}), { canceled: true, filePaths: [] })
  assert.equal((await shim.dialog.showSaveDialog({})).canceled, true)
  assert.equal(await shim.shell.openExternal('https://example.com/pay?token=abc'), false)
  assert.match(logs.join('\n'), /not opening a browser for https:\/\/example.com\/pay/)
  assert.doesNotMatch(logs.join('\n'), /token=abc/)
})

test('ipcMain records handlers and headless.ipc.invoke reaches them', async (t) => {
  const { shim } = makeShim(t)
  shim.ipcMain.handle('thing:get', (_e, a, b) => a + b)
  assert.deepEqual(shim.headless.ipc.channels(), ['thing:get'])
  assert.equal(await shim.headless.ipc.invoke('thing:get', 2, 3), 5)
  await assert.rejects(shim.headless.ipc.invoke('nope'), /No handler registered/)
})

test('safeStorage round trip, unique ciphertexts, tamper and wrong key rejected', () => {
  const a = secretBox.createSafeStorage(Buffer.alloc(32, 1))
  const b = secretBox.createSafeStorage(Buffer.alloc(32, 2))
  const blob = a.encryptString('tmdb-secret-value')
  assert.equal(a.decryptString(blob), 'tmdb-secret-value')
  assert.notEqual(a.encryptString('x').toString('hex'), a.encryptString('x').toString('hex'))
  assert.equal(blob.includes(Buffer.from('tmdb-secret-value')), false)
  assert.throws(() => b.decryptString(blob), /Decryption failed/)
  const tampered = Buffer.from(blob)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => a.decryptString(tampered), /Decryption failed/)
  assert.throws(() => a.decryptString(Buffer.from('short')), /Decryption failed/)
  assert.equal(a.isEncryptionAvailable(), true)
  assert.notEqual(a.getSelectedStorageBackend(), 'basic_text')
})

test('safeStorage without a key reports unavailable and refuses to encrypt', () => {
  const none = secretBox.createSafeStorage(null)
  assert.equal(none.isEncryptionAvailable(), false)
  assert.throws(() => none.encryptString('x'))
  assert.throws(() => none.decryptString(Buffer.from('x')))
})

test('a key from BEEBO_SECRET_KEY: hex and passphrase forms, minimum length', (t) => {
  const dataDir = tmp(t)
  const hex = 'ab'.repeat(32)
  const one = secretBox.resolveMasterKey({ env: { BEEBO_SECRET_KEY: hex }, dataDir })
  const two = secretBox.resolveMasterKey({ env: { BEEBO_SECRET_KEY: hex }, dataDir })
  assert.equal(one.source, 'env')
  assert.deepEqual(one.key, two.key)
  const phrase = secretBox.resolveMasterKey({ env: { BEEBO_SECRET_KEY: 'a long passphrase that is fine 123' }, dataDir })
  assert.equal(phrase.key.length, 32)
  assert.throws(() => secretBox.resolveMasterKey({ env: { BEEBO_SECRET_KEY: 'too short' }, dataDir }), /at least 32 characters/)
  assert.equal(fs.existsSync(path.join(dataDir, 'secret.key')), false)
})

test('BEEBO_SECRET_KEY_FILE is read, a missing file is a clear error', (t) => {
  const dataDir = tmp(t)
  const keyFile = path.join(dataDir, 'docker-secret')
  fs.writeFileSync(keyFile, 'f'.repeat(64) + '\n')
  const r = secretBox.resolveMasterKey({ env: { BEEBO_SECRET_KEY_FILE: keyFile }, dataDir })
  assert.equal(r.source, 'env-file')
  assert.equal(r.key.length, 32)
  assert.throws(() => secretBox.resolveMasterKey({ env: { BEEBO_SECRET_KEY_FILE: path.join(dataDir, 'missing') }, dataDir }), /Cannot read BEEBO_SECRET_KEY_FILE/)
})

test('with no key configured a private key file is generated and reused', { skip: !POSIX && 'POSIX permission bits' }, (t) => {
  const dataDir = tmp(t)
  const first = secretBox.resolveMasterKey({ env: {}, dataDir })
  assert.equal(first.source, 'generated-key-file')
  const file = path.join(dataDir, 'secret.key')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const second = secretBox.resolveMasterKey({ env: {}, dataDir })
  assert.equal(second.source, 'key-file')
  assert.deepEqual(first.key, second.key)
})

test('a key file that other users can read is tightened, or refused', { skip: !POSIX && 'POSIX permission bits' }, (t) => {
  const dataDir = tmp(t)
  const file = path.join(dataDir, 'secret.key')
  fs.writeFileSync(file, 'c'.repeat(64) + '\n', { mode: 0o644 })
  fs.chmodSync(file, 0o644)
  secretBox.resolveMasterKey({ env: {}, dataDir })
  assert.equal(fs.statSync(file).mode & 0o077, 0)
})

test('no key and no writable place for one refuses instead of storing plaintext', (t) => {
  const dataDir = tmp(t)
  const blocker = path.join(dataDir, 'a-file')
  fs.writeFileSync(blocker, 'x')
  assert.throws(() => secretBox.resolveMasterKey({ env: {}, dataDir: path.join(blocker, 'sub') }), (err) => err instanceof secretBox.SecretKeyError && /BEEBO_SECRET_KEY/.test(err.message))
  assert.throws(() => secretBox.resolveMasterKey({ env: {}, dataDir: '' }), secretBox.SecretKeyError)
})

test('plaintext secrets only with the explicit opt-in, and then encryption reports unavailable', (t) => {
  const dataDir = tmp(t)
  for (const off of ['', '0', 'no', 'false']) {
    const r = secretBox.resolveMasterKey({ env: { BEEBO_ALLOW_PLAINTEXT_SECRETS: off }, dataDir })
    assert.equal(r.plaintext, false)
  }
  const on = secretBox.resolveMasterKey({ env: { BEEBO_ALLOW_PLAINTEXT_SECRETS: '1' }, dataDir: path.join(dataDir, 'never-made') })
  assert.equal(on.plaintext, true)
  assert.equal(on.key, null)
  assert.equal(secretBox.createSafeStorage(on.key).isEncryptionAvailable(), false)
})

test('a changed key is detected at boot instead of silently signing everyone out', (t) => {
  const dataDir = tmp(t)
  const a = secretBox.createSafeStorage(Buffer.alloc(32, 1))
  const b = secretBox.createSafeStorage(Buffer.alloc(32, 2))
  assert.deepEqual(secretBox.verifyKeyMatchesData(dataDir, a), { checked: true, created: true })
  assert.deepEqual(secretBox.verifyKeyMatchesData(dataDir, a), { checked: true, created: false })
  assert.throws(() => secretBox.verifyKeyMatchesData(dataDir, b), /does not match the one this data folder/)
  assert.deepEqual(secretBox.verifyKeyMatchesData(dataDir, secretBox.createSafeStorage(null)), { checked: false })
})

test('secretSettings works against the shim safeStorage: secrets are encrypted on disk', (t) => {
  const { createSecretSettings, APP_SECRET_KEYS } = require(path.join(__dirname, '..', 'electron', 'secretSettings.js'))
  const data = {}
  const store = {
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v },
    has: (k) => k in data,
    delete: (k) => { delete data[k] }
  }
  const safeStorage = secretBox.createSafeStorage(Buffer.alloc(32, 9))
  createSecretSettings({ store, safeStorage, keys: APP_SECRET_KEYS, log: () => {} }).install()
  store.set('tmdbApiKey', 'super-secret-tmdb-key-value')
  assert.equal(store.get('tmdbApiKey'), 'super-secret-tmdb-key-value')
  assert.equal(JSON.stringify(data).includes('super-secret-tmdb-key-value'), false)
  assert.ok(data.encryptedSettings && data.encryptedSettings.tmdbApiKey)
})
