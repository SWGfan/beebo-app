// Backup and restore (electron/backup.js) and the website's admin Backup tab.
// Run: node --test test/backup-restore.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const https = require('node:https')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))

const backup = localRequire('./electron/backup')
const auth = localRequire('./electron/auth')
const { createSecretSettings, ENC_KEY } = localRequire('./electron/secretSettings')

// electron-store's surface over a plain object ("the file").
function fakeStore(initial = {}, file) {
  const data = JSON.parse(JSON.stringify(initial))
  return {
    data,
    path: file,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) },
    has: (k) => k in data,
    delete: (k) => { delete data[k] },
    get store() { return JSON.parse(JSON.stringify(data)) }
  }
}
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (v) => Buffer.from('DPAPI:' + Buffer.from(v, 'utf8').toString('hex')),
    decryptString: (b) => {
      const t = b.toString('utf8')
      if (!t.startsWith('DPAPI:')) throw new Error('bad blob')
      return Buffer.from(t.slice(6), 'hex').toString('utf8')
    }
  }
}
function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `beebo-backup-${tag}-`)) }

const ss = fakeSafeStorage()
const USERS = [
  { id: 'u-owner', name: 'Nick', username: 'nick', email: '', status: 'approved', isAdmin: true, createdAt: 1, passwordHash: 'scrypt$salt$ownerhash', code: null, codeHash: null },
  { id: 'u-kid', name: 'Kid', username: 'kid', email: '', status: 'approved', isAdmin: false, createdAt: 2, passwordHash: null, code: 'PASS1234', codeHash: 'hash-of-pass' }
]
// A populated server: one key in every section, the OS-encrypted secrets, and the relay blob.
function populatedStore(dir) {
  const store = fakeStore({
    moviesDir: 'D:\\Movies', tvShowsDir: 'D:\\TV', extraMoviesDirs: ['E:\\More'], allowNewAccounts: false,
    tmdbCacheDir: path.join(dir, 'cache'), emailUser: 'me@example.com',
    authUsers: USERS, accessRequests: [{ id: 'r1', name: 'Gran' }],
    watchHistory: [{ id: 'h1', file: 'Film.mp4', position: 120, duration: 5400 }], watchHistoryPending: [],
    libraryFlags: { 'u-kid': { 'movie:abc': { favorite: true, watched: true, at: 5 } } },
    watchlist: [{ id: 'abc', kind: 'movie' }],
    titleDecisions: { 'Film.mp4': { tmdbId: 42, kind: 'movie' } }, movieTitleOverrides: { 'x.mp4': 'X' },
    qualityFlags: { 'Film.mp4': { flagged: true } },
    rtcRelay: { kind: 'turn', urls: ['turn:relay.example:3478'], secretEnc: ss.encryptString('turn-shared-secret').toString('base64') },
    relayMode: 'beebo_first', relayUsage: { month: '2026-09', bytes: 10 },
    sessionSecret: 'session-secret-abc', apiTokenSecret: 'api-secret-abc', mediaTokenSecret: 'media-secret-abc',
    uploadIdSecret: 'upload-secret-abc', duckdnsToken: 'duck-token-abc', otherCredentials: 'router: admin/hunter2',
    somethingNewFromAnotherAgent: { hello: 'world' },
    license: { token: 'tok', deviceId: 'this-pc' }, walletCache: { me: 1 }, loginLockouts: { x: 1 },
    tmdbApiKey: 'tmdb-key-123', emailAppPassword: 'abcd efgh ijkl mnop', cloudflareAnalyticsToken: 'cf-token-abc'
  }, path.join(dir, 'config.json'))
  createSecretSettings({ store, safeStorage: ss, keys: ['tmdbApiKey', 'emailAppPassword', 'cloudflareAnalyticsToken'] }).install().migrate()
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'cache', 'video-quality-cache.json'), JSON.stringify({ 'D:\\Movies\\Film.mp4::1::2': '1080p' }))
  return store
}
function freshStore(dir) {
  const store = fakeStore({}, path.join(dir, 'config.json'))
  createSecretSettings({ store, safeStorage: ss, keys: ['tmdbApiKey', 'emailAppPassword', 'cloudflareAnalyticsToken'] }).install()
  return store
}
const SECRET_STRINGS = ['scrypt$salt$ownerhash', 'PASS1234', 'hash-of-pass', 'turn-shared-secret', 'session-secret-abc', 'api-secret-abc',
  'media-secret-abc', 'upload-secret-abc', 'duck-token-abc', 'hunter2', 'tmdb-key-123', 'abcd efgh ijkl mnop', 'cf-token-abc']
// What a restore should reproduce: the store as a backup sees it, with the relay secret decrypted.
function comparable(store) {
  const plain = store.exportPlain()
  for (const k of backup.EXCLUDED_KEYS) delete plain[k]
  if (plain.rtcRelay && plain.rtcRelay.secretEnc) plain.rtcRelay = { ...plain.rtcRelay, secretEnc: ss.decryptString(Buffer.from(plain.rtcRelay.secretEnc, 'base64')) }
  return plain
}

test('round trip with passwords and keys: export, then restore on a fresh store, equals the original', () => {
  const a = tmpDir('src'), b = tmpDir('dst')
  try {
    const src = populatedStore(a)
    const data = backup.createBackup(src, { includeSecrets: true, passphrase: 'correct horse battery', cacheDir: path.join(a, 'cache'), safeStorage: ss, appVersion: '0.1.33' })
    const text = backup.serializeBackup(data)
    for (const secret of SECRET_STRINGS) assert.ok(!text.includes(secret), `secret ${secret} is not readable in the file`)
    assert.ok(!text.includes('this-pc'), 'licence identity is not exported')
    assert.equal(data.sections.other.somethingNewFromAnotherAgent.hello, 'world', 'unlisted keys still travel')

    const dst = freshStore(b)
    const opened = backup.openBackup(backup.parseBackupText(text), { passphrase: 'correct horse battery' })
    const summary = backup.summarizeRestore(dst, opened)
    assert.equal(summary.users.inBackup, 2)
    assert.deepEqual(summary.users.needNewPass, [])
    assert.equal(summary.secrets.included, true)
    const r = backup.applyRestore(dst, opened, { safetyDir: path.join(b, 'safety'), cacheDir: path.join(b, 'cache'), safeStorage: ss })
    assert.equal(r.ok, true)
    assert.deepEqual(comparable(dst), comparable(src))
    assert.equal(dst.data.tmdbApiKey, undefined, 'the restored TMDB key is OS-encrypted again')
    assert.equal(dst.get('tmdbApiKey'), 'tmdb-key-123')
    assert.ok(dst.data[ENC_KEY].emailAppPassword)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, 'cache', 'video-quality-cache.json'), 'utf8')), { 'D:\\Movies\\Film.mp4::1::2': '1080p' })
    assert.equal(dst.data.license, undefined)
  } finally {
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true })
  }
})

test('without the tick there are no passwords or keys in the file, and a restore keeps the ones already here', () => {
  const a = tmpDir('nosec'), b = tmpDir('nosec-dst')
  try {
    const src = populatedStore(a)
    assert.throws(() => backup.createBackup(src, { includeSecrets: true }), { code: 'passphrase_required' })
    assert.throws(() => backup.createBackup(src, { includeSecrets: true, passphrase: 'short' }), { code: 'passphrase_too_short' })
    const text = backup.serializeBackup(backup.createBackup(src, { cacheDir: path.join(a, 'cache'), safeStorage: ss }))
    for (const secret of SECRET_STRINGS) assert.ok(!text.includes(secret), `no ${secret}`)
    assert.equal(JSON.parse(text).secrets, null)

    // Restore onto a server that already has these people with different passwords.
    const dst = freshStore(b)
    dst.set('authUsers', [{ ...USERS[0], passwordHash: 'scrypt$salt$newpc', name: 'Old name' }])
    dst.set('sessionSecret', 'keep-me')
    dst.set('rtcRelay', { kind: 'turn', urls: [], secretEnc: ss.encryptString('here-secret').toString('base64') })
    const opened = backup.openBackup(backup.parseBackupText(text), {})
    const summary = backup.summarizeRestore(dst, opened)
    assert.deepEqual(summary.users.added, ['Kid'])
    assert.deepEqual(summary.users.updated, ['Nick'])
    assert.deepEqual(summary.users.needNewPass, ['Kid'])
    backup.applyRestore(dst, opened, { safetyDir: path.join(b, 'safety'), safeStorage: ss })
    const users = dst.get('authUsers')
    assert.equal(users.find((u) => u.id === 'u-owner').passwordHash, 'scrypt$salt$newpc', 'existing password kept')
    assert.equal(users.find((u) => u.id === 'u-owner').name, 'Nick', 'the rest of the row restored')
    assert.equal(users.find((u) => u.id === 'u-kid').code, undefined)
    assert.equal(dst.get('sessionSecret'), 'keep-me')
    assert.equal(ss.decryptString(Buffer.from(dst.get('rtcRelay').secretEnc, 'base64')), 'here-secret', 'same relay kind keeps its secret')
    assert.deepEqual(dst.get('rtcRelay').urls, ['turn:relay.example:3478'])
  } finally {
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true })
  }
})

test('passphrase: round trip works, a wrong or missing passphrase is refused and nothing is written', () => {
  const env = backup.encryptPayload('pass phrase one', '{"x":1}')
  assert.equal(backup.decryptPayload('pass phrase one', env), '{"x":1}')
  assert.throws(() => backup.decryptPayload('pass phrase two', env))

  const a = tmpDir('pp')
  try {
    const src = populatedStore(a)
    const parsed = backup.parseBackupText(backup.serializeBackup(backup.createBackup(src, { includeSecrets: true, passphrase: 'right passphrase', safeStorage: ss })))
    assert.equal(parsed.needsPassphrase, true)
    assert.throws(() => backup.openBackup(parsed, {}), { code: 'passphrase_required' })
    assert.throws(() => backup.openBackup(parsed, { passphrase: 'wrong passphrase' }), { code: 'wrong_passphrase' })
    // Tampered ciphertext is refused too (GCM tag).
    const tampered = JSON.parse(JSON.stringify(parsed.data))
    tampered.secrets.ciphertext = Buffer.from('x' + Buffer.from(tampered.secrets.ciphertext, 'base64').toString('latin1')).toString('base64')
    assert.throws(() => backup.openBackup({ ...parsed, data: tampered }, { passphrase: 'right passphrase' }), { code: 'wrong_passphrase' })
    // Skipping secrets opens the rest without the passphrase.
    const skipped = backup.openBackup(parsed, { skipSecrets: true })
    assert.equal(skipped.secretsIncluded, false)
    assert.equal(skipped.keys.tmdbApiKey, undefined)
    assert.equal(skipped.keys.moviesDir, 'D:\\Movies')
  } finally {
    fs.rmSync(a, { recursive: true, force: true })
  }
})

test('version and size validation', () => {
  const E = (text, code, opts) => assert.throws(() => backup.parseBackupText(text, opts), { code })
  E('', 'empty')
  E('not json', 'not_json')
  E('[1,2]', 'not_a_backup')
  E('{"hello":"world"}', 'not_a_backup')
  E(JSON.stringify({ format: 'beebo-backup', sections: {} }), 'bad_version')
  E(JSON.stringify({ format: 'beebo-backup', version: '2', sections: {} }), 'bad_version')
  E(JSON.stringify({ format: 'beebo-backup', version: 3, sections: {} }), 'too_new')
  E(JSON.stringify({ format: 'beebo-backup', version: 2 }), 'not_a_backup')
  E(JSON.stringify({ format: 'beebo-backup', version: 2, sections: { settings: [] } }), 'not_a_backup')
  E(JSON.stringify({ version: 7, store: {} }), 'too_new')
  E(JSON.stringify({ store: {} }), 'bad_version')
  E(JSON.stringify({ format: 'beebo-backup', version: 2, sections: {}, pad: 'x'.repeat(2000) }), 'too_large', { maxBytes: 1000 })
  assert.throws(() => backup.parseBackupText(Buffer.alloc(backup.MAX_BACKUP_BYTES + 1, 32)), { code: 'too_large' })
  assert.equal(backup.parseBackupText(JSON.stringify({ format: 'beebo-backup', version: 2, sections: {} })).kind, 'v2')
})

test('old v1 backups still restore, plain and whole-file encrypted', () => {
  const b = tmpDir('v1')
  try {
    const v1 = { version: 1, exportedAt: '2026-08-26T05:13:39Z', store: { moviesDir: 'D:\\Old', authUsers: USERS, tmdbApiKey: 'tmdb-v1' } }
    const plain = backup.openBackup(backup.parseBackupText(JSON.stringify(v1)), {})
    const env = { ...backup.encryptPayload('old pass', JSON.stringify(v1)), magic: 'movieapp-backup-enc-v1' }
    const parsed = backup.parseBackupText(JSON.stringify(env))
    assert.equal(parsed.kind, 'legacy-encrypted')
    assert.throws(() => backup.openBackup(parsed, { passphrase: 'nope' }), { code: 'wrong_passphrase' })
    const enc = backup.openBackup(parsed, { passphrase: 'old pass' })
    assert.deepEqual(enc.keys, plain.keys)
    const dst = freshStore(b)
    backup.applyRestore(dst, enc, { safetyDir: path.join(b, 'safety'), safeStorage: ss })
    assert.equal(dst.get('moviesDir'), 'D:\\Old')
    assert.equal(dst.get('tmdbApiKey'), 'tmdb-v1')
    assert.equal(dst.get('authUsers')[1].code, 'PASS1234')
  } finally {
    fs.rmSync(b, { recursive: true, force: true })
  }
})

test('a safety backup of the current settings is written before anything changes, and it puts them back', () => {
  const a = tmpDir('safe-src'), b = tmpDir('safe-dst')
  try {
    const incoming = backup.serializeBackup(backup.createBackup(populatedStore(a), { safeStorage: ss }))
    const dst = populatedStore(b)
    dst.set('moviesDir', 'Z:\\Before')
    dst.set('watchHistory', [])
    const before = JSON.stringify(dst.store)
    const safetyDir = path.join(b, 'safety')

    // If the safety copy cannot be written, nothing is restored.
    const blocker = path.join(b, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    assert.throws(() => backup.applyRestore(dst, backup.openBackup(backup.parseBackupText(incoming)), { safetyDir: blocker, safeStorage: ss }), { code: 'safety_backup_failed' })
    assert.equal(JSON.stringify(dst.store), before)

    const r = backup.applyRestore(dst, backup.openBackup(backup.parseBackupText(incoming)), { safetyDir, cacheDir: path.join(b, 'cache'), safeStorage: ss })
    assert.ok(r.safetyFile && fs.existsSync(r.safetyFile))
    assert.equal(dst.get('moviesDir'), 'D:\\Movies')
    const listed = backup.listSafetyBackups(safetyDir)
    assert.equal(listed.length, 1)
    const safety = JSON.parse(fs.readFileSync(r.safetyFile, 'utf8'))
    assert.equal(safety.kind, 'safety')
    assert.equal(safety.rawStore.moviesDir, 'Z:\\Before')

    // Putting the safety copy back returns the store to exactly what it was.
    const back = backup.openBackup(backup.parseBackupText(fs.readFileSync(r.safetyFile)))
    backup.applyRestore(dst, back, { safetyDir, safeStorage: ss })
    assert.equal(JSON.stringify(dst.store), before)
    assert.equal(backup.listSafetyBackups(safetyDir).length, 2)
  } finally {
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true })
  }
})

test('restore invalidates the memoised signing secrets (the ae2f459 hooks)', () => {
  const b = tmpDir('memo')
  try {
    const store = freshStore(b)
    store.set('sessionSecret', 'first-secret')
    store.set('authUsers', [USERS[0]])
    const cookie = auth.signSession(store, 'u-owner')
    assert.equal(auth.verifySession(store, cookie), 'u-owner')
    const other = { format: 'beebo-backup', version: 2, sections: {}, files: {}, secrets: null }
    const opened = backup.openBackup(backup.parseBackupText(JSON.stringify(other)))
    opened.keys.sessionSecret = 'restored-secret' // as if unlocked from secrets
    backup.applyRestore(store, opened, { safetyDir: path.join(b, 'safety'), safeStorage: ss })
    assert.equal(auth.verifySession(store, cookie), null, 'a session signed with the old secret no longer verifies')
  } finally {
    fs.rmSync(b, { recursive: true, force: true })
  }
})

test('CSRF token and cross-site checks', () => {
  const t = backup.makeCsrfToken('server-secret', 'session-a')
  assert.equal(backup.checkCsrfToken('server-secret', 'session-a', t), true)
  assert.equal(backup.checkCsrfToken('server-secret', 'session-b', t), false)
  assert.equal(backup.checkCsrfToken('other-secret', 'session-a', t), false)
  assert.equal(backup.checkCsrfToken('server-secret', '', backup.makeCsrfToken('server-secret', '')), false)
  assert.equal(backup.checkCsrfToken('server-secret', 'session-a', ''), false)
  assert.equal(backup.isCrossSiteRequest({ host: 'home.example:8080', origin: 'https://home.example:8080', 'sec-fetch-site': 'same-origin' }), false)
  assert.equal(backup.isCrossSiteRequest({ host: 'home.example:8080' }), false)
  assert.equal(backup.isCrossSiteRequest({ host: 'home.example:8080', origin: 'https://evil.example' }), true)
  assert.equal(backup.isCrossSiteRequest({ host: 'home.example:8080', 'sec-fetch-site': 'cross-site' }), true)
  assert.equal(backup.isCrossSiteRequest({ host: 'home.example:8080', origin: 'null' }), true)
})

// ---------------------------------------------------------------------------
// The website: a real server over TLS (self-signed, made with openssl).
// ---------------------------------------------------------------------------
function makeCert(dir) {
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
    return { cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8') }
  } catch { return null }
}
function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: p, headers, rejectUnauthorized: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
function multipart(fields, file) {
  const boundary = '----beebotest' + Date.now()
  const parts = []
  for (const [k, v] of Object.entries(fields)) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
  if (file) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="${file.name}"\r\nContent-Type: application/json\r\n\r\n${file.text}\r\n`)
  parts.push(`--${boundary}--\r\n`)
  return { body: parts.join(''), type: `multipart/form-data; boundary=${boundary}` }
}

test('website Backup tab: admin + CSRF gates, download, preview, apply with a safety copy', async (t) => {
  const dir = tmpDir('web')
  const cert = makeCert(dir)
  if (!cert) { fs.rmSync(dir, { recursive: true, force: true }); t.skip('openssl not available'); return }
  const server = localRequire('./electron/streamServer')
  let info
  try {
    const store = populatedStore(dir)
    auth.forgetSecrets(); server.forgetSecrets()
    const port = 47000 + Math.floor(Math.random() * 900) + 50
    info = server.startStreamServer({ port, store, getMoviesDir: () => dir, getTvShowsDir: () => dir, getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [], getTmdbCacheDir: () => path.join(dir, 'cache'), log: () => {} })
    assert.equal(info.applyCertificate(cert).ok, true)
    for (let i = 0; i < 50; i++) {
      try { await request(info.port, 'GET', '/login'); break } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    const adminCookie = `beebo_session=${auth.signSession(store, 'u-owner')}`
    const kidCookie = `beebo_session=${auth.signSession(store, 'u-kid')}`
    const form = (o) => new URLSearchParams(o).toString()
    const FORM = 'application/x-www-form-urlencoded'

    // Non-admins get the same 404 as any unknown path, for the page and the actions.
    assert.equal((await request(info.port, 'GET', '/admin?tab=backup', { headers: { Cookie: kidCookie } })).status, 404)
    assert.equal((await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: kidCookie, 'Content-Type': FORM }, body: form({ csrf: 'x' }) })).status, 404)
    // No session at all: sent to log in.
    assert.equal((await request(info.port, 'POST', '/admin/backup/download', { headers: { 'Content-Type': FORM }, body: 'csrf=x' })).status, 302)

    const page = await request(info.port, 'GET', '/admin?tab=backup', { headers: { Cookie: adminCookie } })
    assert.equal(page.status, 200)
    const csrf = page.body.match(/name="csrf" value="([^"]+)"/)[1]

    // Missing / wrong CSRF token: refused, nothing downloaded.
    let r = await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({}) })
    assert.equal(r.status, 303)
    assert.ok(!r.headers['content-disposition'])
    r = await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ csrf: csrf.slice(1) + 'A' }) })
    assert.equal(r.status, 303)
    // Right token, but posted from another site: refused.
    r = await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: adminCookie, 'Content-Type': FORM, Origin: 'https://evil.example' }, body: form({ csrf }) })
    assert.equal(r.status, 403)
    // A token is bound to the session it was issued to.
    await new Promise((res) => setTimeout(res, 5))
    const otherAdminSession = `beebo_session=${auth.signSession(store, 'u-owner')}`
    assert.notEqual(otherAdminSession, adminCookie)
    r = await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: otherAdminSession, 'Content-Type': FORM }, body: form({ csrf }) })
    assert.equal(r.status, 303, 'a valid admin session with another session’s token is refused')
    assert.ok(!r.headers['content-disposition'])

    // The conversions scan is wired through the same admin page: start, then poll its status.
    r = await request(info.port, 'POST', '/admin/conversions/scan-unplayable', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ tab: 'conversions' }) })
    assert.equal(r.status, 303)
    let scanState = null
    for (let i = 0; i < 50; i++) {
      const s = await request(info.port, 'GET', '/admin/conversions/scan-status', { headers: { Cookie: adminCookie } })
      assert.equal(s.status, 200)
      scanState = JSON.parse(s.body)
      if (scanState.scan && scanState.scan.state === 'done') break
      await new Promise((res) => setTimeout(res, 50))
    }
    assert.equal(scanState.scan.state, 'done')
    assert.match(scanState.text, /Last scan: checked 0 files/)
    assert.equal((await request(info.port, 'GET', '/admin/conversions/scan-status', { headers: { Cookie: kidCookie } })).status, 404)
    const convPage = await request(info.port, 'GET', '/admin?tab=conversions', { headers: { Cookie: adminCookie } })
    assert.match(convPage.body, /Scan the whole library for files that will not play/)

    // Download without secrets.
    r = await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ csrf }) })
    assert.equal(r.status, 200)
    assert.match(r.headers['content-disposition'], /attachment; filename="beebo-backup-/)
    for (const secret of SECRET_STRINGS) assert.ok(!r.body.includes(secret), `download has no ${secret}`)
    // With secrets: mismatched passphrases refused; matching ones give an encrypted secrets block.
    r = await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ csrf, includeSecrets: '1', passphrase: 'long passphrase', passphrase2: 'other passphrase' }) })
    assert.equal(r.status, 303)
    r = await request(info.port, 'POST', '/admin/backup/download', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ csrf, includeSecrets: '1', passphrase: 'long passphrase', passphrase2: 'long passphrase' }) })
    assert.equal(r.status, 200)
    const withSecrets = r.body
    assert.ok(JSON.parse(withSecrets).secrets.ciphertext)
    for (const secret of SECRET_STRINGS) assert.ok(!withSecrets.includes(secret))

    // Change something, then restore the backup through the two-step flow.
    store.set('moviesDir', 'Q:\\Changed')
    const upWrong = multipart({ csrf, passphrase: 'wrong passphrase!' }, { name: 'b.json', text: withSecrets })
    r = await request(info.port, 'POST', '/admin/backup/restore-preview', { headers: { Cookie: adminCookie, 'Content-Type': upWrong.type }, body: upWrong.body })
    assert.equal(r.status, 303, 'wrong passphrase goes back with an error')
    const upNoCsrf = multipart({ passphrase: 'long passphrase' }, { name: 'b.json', text: withSecrets })
    r = await request(info.port, 'POST', '/admin/backup/restore-preview', { headers: { Cookie: adminCookie, 'Content-Type': upNoCsrf.type }, body: upNoCsrf.body })
    assert.equal(r.status, 303)
    assert.ok(!/restore-apply/.test(r.body))
    const up = multipart({ csrf, passphrase: 'long passphrase' }, { name: 'b.json', text: withSecrets })
    r = await request(info.port, 'POST', '/admin/backup/restore-preview', { headers: { Cookie: adminCookie, 'Content-Type': up.type }, body: up.body })
    assert.equal(r.status, 200)
    assert.match(r.body, /This is what the restore would change/)
    assert.equal(store.get('moviesDir'), 'Q:\\Changed', 'preview changes nothing')
    const stage = r.body.match(/name="stage" value="([^"]+)"/)[1]

    // Apply needs the CSRF token too.
    r = await request(info.port, 'POST', '/admin/backup/restore-apply', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ stage }) })
    assert.equal(r.status, 303)
    assert.equal(store.get('moviesDir'), 'Q:\\Changed')
    r = await request(info.port, 'POST', '/admin/backup/restore-apply', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ csrf, stage }) })
    assert.equal(r.status, 303)
    assert.equal(store.get('moviesDir'), 'D:\\Movies')
    const safety = backup.listSafetyBackups(path.join(dir, 'safety-backups'))
    assert.equal(safety.length, 1, 'safety copy written next to config.json')
    assert.equal(JSON.parse(fs.readFileSync(safety[0].path, 'utf8')).rawStore.moviesDir, 'Q:\\Changed')
    // The stage is single-use.
    r = await request(info.port, 'POST', '/admin/backup/restore-apply', { headers: { Cookie: adminCookie, 'Content-Type': FORM }, body: form({ csrf, stage }) })
    assert.equal(r.status, 303)

    // Too large: refused from the declared length, before reading the body.
    r = await request(info.port, 'POST', '/admin/backup/restore-preview', { headers: { Cookie: adminCookie, 'Content-Type': up.type, 'Content-Length': String(backup.MAX_BACKUP_BYTES + 10 * 1024 * 1024) } }).catch((e) => ({ status: 'reset', e }))
    assert.ok(r.status === 413 || r.status === 'reset')
  } finally {
    if (info) await new Promise((r) => info.close(r))
    auth.forgetSecrets(); server.forgetSecrets()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('owner exports omit private viewing records, list state and credentials, including encrypted and safety backups', () => {
  const dir = tmpDir('viewing-private')
  try {
    const secret = 'Private Aurora Episode.mkv'
    const secretHash = 'private-password-hash'
    const store = fakeStore({
      authUsers: [{ id: 'private', adult: true, viewingHistoryPrivate: true, passwordHash: secretHash, privacySessionSalt: 'private-session-salt', code: 'private-access-code' }, { id: 'public', passwordHash: 'public-password-hash' }],
      watchHistory: [{ userId: 'private', fileName: secret }, { userId: 'public', fileName: 'Public.mp4' }],
      watchHistoryPending: [{ userId: 'private', title: secret }],
      watchedState: { schema: 1, users: { private: { files: { [secret]: { watched: true } } }, public: { files: { 'Public.mp4': {} } } } },
      libraryFlags: { private: { [secret]: { favorite: true } }, public: {} },
      watchlist: { private: [{ title: secret }], public: [] },
      playlists: { schema: 1, lists: [{ ownerId: 'private', name: secret }, { ownerId: 'public', name: 'Family films' }], progress: { private: { [secret]: 4 }, public: {} } },
      watchedStateMigrationBackups: [{ at: 1, libraryFlags: { private: { [secret]: { watched: true } } } }],
      encryptedSettings: { 'authUsers#fields': 'opaque-private-access-code-blob', tmdbApiKey: 'kept-machine-blob' }
    })
    for (const includeSecrets of [false, true]) {
      const data = backup.createBackup(store, { includeSecrets, passphrase: 'long backup phrase' })
      const text = JSON.stringify(data)
      assert.equal(text.includes(secret), false)
      const opened = backup.openBackup(backup.parseBackupText(text), { passphrase: 'long backup phrase' })
      for (const value of [secret, secretHash, 'private-access-code', 'private-session-salt']) assert.equal(JSON.stringify(opened).includes(value), false, value)
      assert.equal(opened.keys.authUsers.find(u => u.id === 'private').viewingHistoryPrivate, true)
      if (includeSecrets) assert.equal(opened.userCredentials.public.passwordHash, 'public-password-hash')
    }
    assert.equal(JSON.stringify(backup.exportBackup(store)).includes(secret), false)
    const file = backup.writeSafetyBackup(store, { safetyDir: dir })
    const safety = fs.readFileSync(file, 'utf8')
    for (const value of [secret, secretHash, 'private-access-code', 'private-session-salt']) assert.equal(safety.includes(value), false, value)
    assert.equal(store.get('watchHistory')[0].fileName, secret, 'export never mutates the member data')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('normal, safety and legacy restores cannot disable current privacy, replace credentials or overwrite personal viewing state', () => {
  const dir = tmpDir('private-restore')
  try {
    const privateUser = { id: 'private', adult: true, viewingHistoryPrivate: true, passwordHash: 'member-current-password', privacySessionSalt: 'current-random-salt', email: 'member@example.test' }
    const current = {
      authUsers: [privateUser, { id: 'public' }],
      watchHistory: [{ userId: 'private', title: 'Private current title' }], watchHistoryPending: [],
      watchedState: { schema: 1, users: { private: { files: { 'movie:Private current title': { watched: true } } } } },
      libraryFlags: { private: { 'private-favourite': { favorite: true } } },
      watchlist: { private: [{ title: 'Private later' }] },
      playlists: { schema: 1, lists: [{ ownerId: 'private', name: 'Private list' }], progress: { private: { marker: 7 } } }
    }
    const old = {
      authUsers: [{ id: 'private', adult: false, viewingHistoryPrivate: false, passwordHash: 'owner-known-old-password', privacySessionSalt: '' }, { id: 'public' }],
      watchHistory: [{ userId: 'private', title: 'Old private title' }, { userId: 'public', title: 'Restored public title' }],
      watchHistoryPending: [{ userId: 'private', title: 'Old pending title' }],
      watchedState: { schema: 1, users: { private: { files: { old: {} } }, public: { files: {} } } },
      libraryFlags: { private: { 'old-favourite': {} } }, watchlist: { private: [{ title: 'Old later' }] },
      playlists: { schema: 1, lists: [{ ownerId: 'private', name: 'Old list' }], progress: { private: { old: 1 } } },
      watchedStateMigrationBackups: [{ libraryFlags: { private: { 'old-hidden-title': {} } } }]
    }
    const formats = [
      backup.openBackup(backup.parseBackupText(JSON.stringify(backup.createBackup(fakeStore(old), { includeSecrets: true, passphrase: 'restore phrase' }))), { passphrase: 'restore phrase' }),
      backup.openBackup(backup.parseBackupText(JSON.stringify({ format: backup.BACKUP_FORMAT, version: backup.BACKUP_VERSION, kind: 'safety', rawStore: old }))),
      backup.openBackup(backup.parseBackupText(JSON.stringify({ version: 1, store: old })))
    ]
    for (const opened of formats) {
      const store = fakeStore(current)
      backup.applyRestore(store, opened, { safetyDir: dir })
      assert.deepEqual(store.get('authUsers').find(u => u.id === 'private'), privateUser)
      assert.deepEqual(store.get('watchHistory').filter(r => r.userId === 'private'), current.watchHistory)
      assert.equal(store.get('watchHistory').some(r => r.title === 'Restored public title'), true)
      for (const key of ['libraryFlags', 'watchlist']) assert.deepEqual(store.get(key).private, current[key].private)
      assert.deepEqual(store.get('watchedState').users.private, current.watchedState.users.private)
      assert.deepEqual(store.get('playlists').lists.find(r => r.ownerId === 'private'), current.playlists.lists[0])
      assert.equal(JSON.stringify(store.get('watchedStateMigrationBackups')).includes('old-hidden-title'), false)
    }
    const legacy = fakeStore(current)
    assert.equal(backup.importBackup(legacy, { store: old }).ok, true)
    assert.deepEqual(legacy.get('authUsers').find(u => u.id === 'private'), privateUser)
    const omitted = fakeStore(current)
    backup.applyRestore(omitted, { keys: { authUsers: [] }, files: {} }, { safetyDir: dir })
    assert.deepEqual(omitted.get('authUsers'), [privateUser])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('legacy restore without secrets strips credentials before privacy restore processing', () => {
  const opened = backup.openBackup(backup.parseBackupText(JSON.stringify({ version: 1, store: { authUsers: [{ id: 'a', passwordHash: 'old-secret', privacySessionSalt: 'old-salt' }] } })), { skipSecrets: true })
  assert.deepEqual(opened.keys.authUsers, [{ id: 'a' }])
})

test('dotted store paths in imported backups cannot bypass private-user preservation', () => {
  const dir = tmpDir('private-paths')
  try {
    const privateUser = { id: 'private', adult: true, viewingHistoryPrivate: true, passwordHash: 'member-password', privacySessionSalt: 'salt' }
    const store = fakeStore({ authUsers: [privateUser] })
    const result = backup.applyRestore(store, { keys: { 'authUsers.0.viewingHistoryPrivate': false, 'authUsers.0.passwordHash': 'owner-password', 'watchHistory.0.title': 'Hidden title', moviesDir: 'D:\\Movies' }, files: {} }, { safetyDir: dir })
    assert.deepEqual(result.written, ['moviesDir'])
    assert.deepEqual(store.get('authUsers'), [privateUser])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
