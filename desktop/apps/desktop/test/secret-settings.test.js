// The TMDB key and email app password: encrypted at rest with the OS, migrated
// from plain text without ever losing them. Run: node --test test/secret-settings.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createSecretSettings, ENC_KEY } = require(path.join(__dirname, '..', 'electron', 'secretSettings.js'))
const backup = require(path.join(__dirname, '..', 'electron', 'backup.js'))

// electron-store's surface, over a plain object we can inspect ("the file").
function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return {
    data,
    get: (k, d) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v },
    has: (k) => k in data,
    delete: (k) => { delete data[k] },
    get store() { return JSON.parse(JSON.stringify(data)) },
  }
}
// A stand-in for DPAPI: reversible, obviously not plain text, and switchable.
function fakeSafeStorage({ available = true } = {}) {
  const s = {
    on: available,
    isEncryptionAvailable: () => s.on,
    encryptString: (v) => { if (!s.on) throw new Error('no'); return Buffer.from('DPAPI:' + Buffer.from(v, 'utf8').toString('hex')) },
    decryptString: (b) => {
      if (!s.on) throw new Error('no')
      const t = b.toString('utf8')
      if (!t.startsWith('DPAPI:')) throw new Error('bad blob')
      return Buffer.from(t.slice(6), 'hex').toString('utf8')
    },
  }
  return s
}

test('first run: plain-text secrets are encrypted and the plain copies removed; readers see the same values', () => {
  const store = fakeStore({ tmdbApiKey: 'tmdb-key-123', emailAppPassword: 'abcd efgh ijkl mnop', emailUser: 'me@example.com' })
  const ss = createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  // Before migration readers already work.
  assert.equal(store.get('tmdbApiKey'), 'tmdb-key-123')
  const r = ss.migrate()
  assert.deepEqual(r.migrated.sort(), ['emailAppPassword', 'tmdbApiKey'])
  const file = JSON.stringify(store.data)
  assert.ok(!file.includes('tmdb-key-123'), 'no plain TMDB key on disk')
  assert.ok(!file.includes('abcd efgh ijkl mnop'), 'no plain email password on disk')
  assert.equal(store.data.tmdbApiKey, undefined)
  assert.ok(store.data[ENC_KEY].tmdbApiKey)
  // Every existing reader (store.get, mailer.isConfigured) keeps working.
  assert.equal(store.get('tmdbApiKey'), 'tmdb-key-123')
  assert.equal(store.get('emailAppPassword'), 'abcd efgh ijkl mnop')
  assert.equal(store.get('emailUser'), 'me@example.com', 'other keys untouched')
  assert.equal(require(path.join(__dirname, '..', 'electron', 'mailer.js')).isConfigured(store), true)
  // Running it again (every start) changes nothing.
  assert.deepEqual(ss.migrate().migrated, [])
  assert.equal(store.get('tmdbApiKey'), 'tmdb-key-123')
})

test('saving a new value encrypts it; clearing removes both copies', () => {
  const store = fakeStore()
  createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  store.set('tmdbApiKey', 'new-key')
  assert.equal(store.data.tmdbApiKey, undefined)
  assert.equal(store.get('tmdbApiKey'), 'new-key')
  store.set({ emailAppPassword: 'pw-1', moviesDir: 'D:\\Movies' })
  assert.equal(store.get('emailAppPassword'), 'pw-1')
  assert.equal(store.data.moviesDir, 'D:\\Movies')
  store.set('tmdbApiKey', '')
  assert.equal(store.get('tmdbApiKey'), undefined)
  assert.equal(store.get('tmdbApiKey', 'fallback'), 'fallback')
  assert.equal(store.has('tmdbApiKey'), false)
  assert.equal(store.data[ENC_KEY].tmdbApiKey, undefined)
})

test('without OS encryption nothing is lost: plain text is read, kept, and migrated later', () => {
  const safe = fakeSafeStorage({ available: false })
  const store = fakeStore({ tmdbApiKey: 'old-plain' })
  const ss = createSecretSettings({ store, safeStorage: safe }).install()
  assert.deepEqual(ss.migrate(), { migrated: [], kept: ['tmdbApiKey'] })
  assert.equal(store.data.tmdbApiKey, 'old-plain', 'plain copy kept')
  assert.equal(store.get('tmdbApiKey'), 'old-plain')
  store.set('emailAppPassword', 'typed-while-unavailable')
  assert.equal(store.get('emailAppPassword'), 'typed-while-unavailable')
  // Encryption becomes available (e.g. the app is now ready): migrated then.
  safe.on = true
  assert.deepEqual(ss.migrate().migrated.sort(), ['emailAppPassword', 'tmdbApiKey'])
  assert.equal(store.get('tmdbApiKey'), 'old-plain')
  assert.equal(store.get('emailAppPassword'), 'typed-while-unavailable')
})

test('a failed encryption or an unreadable blob never deletes the plain value', () => {
  const safe = fakeSafeStorage()
  safe.encryptString = () => Buffer.from('garbage')   // decrypts to something else
  const store = fakeStore({ tmdbApiKey: 'keep-me' })
  const ss = createSecretSettings({ store, safeStorage: safe }).install()
  assert.deepEqual(ss.migrate().kept, ['tmdbApiKey'])
  assert.equal(store.data.tmdbApiKey, 'keep-me')
  assert.equal(store.get('tmdbApiKey'), 'keep-me')

  // A config copied from another PC: the blob won't open here, the plain text still reads.
  const store2 = fakeStore({ tmdbApiKey: 'plain-still-here', [ENC_KEY]: { tmdbApiKey: Buffer.from('other-pc').toString('base64') } })
  createSecretSettings({ store: store2, safeStorage: fakeSafeStorage() }).install()
  assert.equal(store2.get('tmdbApiKey'), 'plain-still-here')
  // And a blob that won't open with no plain text is simply "not set", not a crash.
  const store3 = fakeStore({ [ENC_KEY]: { tmdbApiKey: Buffer.from('other-pc').toString('base64') } })
  createSecretSettings({ store: store3, safeStorage: fakeSafeStorage() }).install()
  assert.equal(store3.get('tmdbApiKey', ''), '')
})

test('a downgraded app that wrote plain text again: the newer plain value wins and is re-encrypted', () => {
  const store = fakeStore()
  const ss = createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  store.set('tmdbApiKey', 'v1')
  store.data.tmdbApiKey = 'v2-from-old-app'
  assert.equal(store.get('tmdbApiKey'), 'v2-from-old-app')
  ss.migrate()
  assert.equal(store.data.tmdbApiKey, undefined)
  assert.equal(store.get('tmdbApiKey'), 'v2-from-old-app')
})

test('backups carry the real values (not machine-bound blobs), and restore re-encrypts them', () => {
  const store = fakeStore({ tmdbApiKey: 'tmdb-key-123', emailAppPassword: 'pw', moviesDir: 'D:\\M' })
  createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install().migrate()
  const data = backup.exportBackup(store)
  assert.equal(data.store.tmdbApiKey, 'tmdb-key-123')
  assert.equal(data.store.emailAppPassword, 'pw')
  assert.equal(data.store[ENC_KEY], undefined)
  const fresh = fakeStore()
  createSecretSettings({ store: fresh, safeStorage: fakeSafeStorage() }).install()
  assert.equal(backup.importBackup(fresh, data).ok, true)
  assert.equal(fresh.data.tmdbApiKey, undefined, 'restored secret is encrypted on the new PC')
  assert.equal(fresh.get('tmdbApiKey'), 'tmdb-key-123')
  assert.equal(fresh.get('moviesDir'), 'D:\\M')
})

// --- security review #21: more secrets, access codes, Linux basic_text ---

const auth = require(path.join(__dirname, '..', 'electron', 'auth.js'))

test('session, token and upload secrets and the licence token are encrypted; readers see the same values', () => {
  const store = fakeStore({
    sessionSecret: 'sess-aaaa', mediaTokenSecret: 'media-bbbb', uploadIdSecret: 'up-cccc', apiTokenSecret: 'api-dddd',
    'license.token': 'eyJwYXlsb2FkIjoxfQ.c2lnbmF0dXJlc2lnbmF0dXJl', moviesDir: 'D:\\M',
  })
  const ss = createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  const r = ss.migrate()
  assert.deepEqual(r.migrated.sort(), ['apiTokenSecret', 'license.token', 'mediaTokenSecret', 'sessionSecret', 'uploadIdSecret'])
  const file = JSON.stringify(store.data)
  for (const s of ['sess-aaaa', 'media-bbbb', 'up-cccc', 'api-dddd', 'c2lnbmF0dXJlc2lnbmF0dXJl']) assert.ok(!file.includes(s), s + ' not on disk')
  assert.equal(store.get('sessionSecret'), 'sess-aaaa')
  assert.equal(store.get('apiTokenSecret'), 'api-dddd')
  assert.equal(store.get('license.token'), 'eyJwYXlsb2FkIjoxfQ.c2lnbmF0dXJlc2lnbmF0dXJl')
  assert.equal(store.get('moviesDir'), 'D:\\M')
})

test('access codes and their hashes in authUsers are encrypted; auth keeps working, before and after', () => {
  const plainStore = fakeStore()
  const { user, code } = auth.createUser(plainStore, 'Nick', 'n@example.com')
  const store = fakeStore(plainStore.data)
  const ss = createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  assert.deepEqual(ss.migrate().migrated, ['authUsers'])
  const file = JSON.stringify(store.data)
  assert.ok(!file.includes(code), 'no plain code on disk')
  assert.ok(!file.includes(user.codeHash.split('$').pop()), 'no code hash on disk')
  assert.equal(store.data.authUsers[0].username, 'nick', 'the rest of the record stays readable')
  assert.equal(auth.findUserByUsernameAndSecret(store, 'nick', code)?.id, user.id)
  assert.equal(auth.getUsers(store)[0].code, code, 'the Users tab can still show it')
  // New codes and users go straight to the encrypted copy.
  const code2 = auth.regenerateCode(store, user.id)
  auth.createUser(store, 'Ann', '')
  assert.ok(!JSON.stringify(store.data).includes(code2))
  assert.equal(auth.findUserByUsernameAndSecret(store, 'nick', code2)?.id, user.id)
  assert.equal(auth.findUserByUsernameAndSecret(store, 'nick', code), null)
  assert.equal(auth.getUsers(store).length, 2)
  // Switching to a password clears the code for good (null wins over the old blob).
  auth.setUserPassword(store, user.id, 'a-long-password')
  assert.equal(auth.getUsers(store)[0].code, null)
  assert.equal(auth.findUserByUsernameAndSecret(store, 'nick', code2), null)
})

test('a generated secret that cannot be opened right now is never overwritten on disk', () => {
  const safe = fakeSafeStorage()
  const store = fakeStore()
  createSecretSettings({ store, safeStorage: safe }).install()
  store.set('sessionSecret', 'the-real-one')
  const blob = store.data[ENC_KEY].sessionSecret
  safe.on = false // e.g. the keyring is locked this time
  assert.equal(store.get('sessionSecret'), undefined)
  store.set('sessionSecret', 'temporary')
  assert.equal(store.get('sessionSecret'), 'temporary', 'this run uses the temporary one')
  assert.equal(store.data[ENC_KEY].sessionSecret, blob, 'stored secret untouched')
  assert.equal(store.data.sessionSecret, undefined)
  safe.on = true
  const fresh = createSecretSettings({ store: fakeStore(store.data), safeStorage: safe })
  assert.equal(fresh.read('sessionSecret'), 'the-real-one', 'next start reads the real one')
})

test('Linux basic_text is refused: secrets stay (or go back to) plain text, with a warning', () => {
  const safe = fakeSafeStorage()
  const first = fakeStore()
  createSecretSettings({ store: first, safeStorage: safe, platform: 'linux' }).install()
  first.set('tmdbApiKey', 'encrypted-with-a-keyring')
  assert.ok(first.data[ENC_KEY].tmdbApiKey)
  // Next start: the keyring is gone and Electron fell back to basic_text.
  safe.getSelectedStorageBackend = () => 'basic_text'
  const logs = []
  const store = fakeStore(first.data)
  const ss = createSecretSettings({ store, safeStorage: safe, platform: 'linux', log: (m) => logs.push(m) }).install()
  ss.migrate()
  assert.equal(store.data.tmdbApiKey, 'encrypted-with-a-keyring', 'moved back to plain text, not lost')
  assert.equal(store.data[ENC_KEY].tmdbApiKey, undefined)
  store.set('emailAppPassword', 'pw')
  assert.equal(store.data.emailAppPassword, 'pw', 'not "encrypted" with a fixed key')
  assert.ok(logs.some((m) => /basic_text/.test(m)))
  // The same backend name elsewhere means nothing.
  const other = fakeStore()
  createSecretSettings({ store: other, safeStorage: safe, platform: 'win32' }).install()
  other.set('tmdbApiKey', 'k')
  assert.equal(other.data.tmdbApiKey, undefined)
})

test('backups carry the new secrets and codes as real values, nested where electron-store nests them', () => {
  const plainStore = fakeStore()
  const { code } = auth.createUser(plainStore, 'Kid', '')
  const store = fakeStore(Object.assign({}, plainStore.data, { sessionSecret: 's1-secret', license: { deviceId: 'dev_1' } }))
  const ss = createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  store.set('license.token', 'tok.tok')
  ss.migrate()
  const data = backup.exportBackup(store)
  assert.equal(data.store.sessionSecret, 's1-secret')
  assert.equal(data.store.authUsers[0].code, code)
  assert.match(data.store.authUsers[0].codeHash, /^scrypt\$/)
  assert.equal(data.store.license.token, 'tok.tok')
  assert.equal(data.store.license.deviceId, 'dev_1')
  assert.equal(data.store['license.token'], undefined)
  // Restore on a new PC re-encrypts everything portable. The licence block is
  // this machine's own identity (EXCLUDED_KEYS) and must never be cloned from
  // someone else's backup, so it is left alone by the legacy import path too.
  const fresh = fakeStore()
  createSecretSettings({ store: fresh, safeStorage: fakeSafeStorage() }).install()
  assert.equal(backup.importBackup(fresh, data).ok, true)
  const file = JSON.stringify(fresh.data)
  for (const s of ['tok.tok', code, 's1-secret']) assert.ok(!file.includes(s), s + ' encrypted after restore')
  assert.equal(fresh.data.license, undefined, 'machine-bound licence identity is not imported from a backup')
  assert.equal(fresh.get('sessionSecret'), 's1-secret')
  assert.equal(auth.findUserByUsernameAndSecret(fresh, 'kid', code)?.username, 'kid')
})

test('integration: v2 backups carry every encrypted key, and a safety copy put back keeps access codes', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const { ENCRYPTED_KEY_NAMES, APP_SECRET_KEYS } = require(path.join(__dirname, '..', 'electron', 'secretSettings.js'))
  // streamServer's renderSettings sends these through store.get.
  for (const k of ['tmdbApiKey', 'emailAppPassword', 'cloudflareAnalyticsToken', 'sessionSecret', 'mediaTokenSecret', 'uploadIdSecret', 'apiTokenSecret', 'license.token', 'authUsers']) {
    assert.ok(ENCRYPTED_KEY_NAMES.includes(k), k + ' is read through store.get')
  }
  const secrets = { sessionSecret: 's1-secret', mediaTokenSecret: 'm1-secret', uploadIdSecret: 'u1-secret', apiTokenSecret: 'a1-secret', cloudflareAnalyticsToken: 'cf-token-1' }
  const store = fakeStore(secrets)
  const ss = createSecretSettings({ store, safeStorage: fakeSafeStorage(), keys: APP_SECRET_KEYS }).install()
  ss.migrate()
  // Users added after the first encryption: authUsers comes after encryptedSettings in the file.
  const { user, code } = auth.createUser(store, 'Kid', '')
  for (const v of Object.values(secrets)) assert.ok(!JSON.stringify(store.data).includes(v), v + ' encrypted on disk')
  const data = backup.createBackup(store, { includeSecrets: true, passphrase: 'correct horse battery' })
  const opened = backup.openBackup(backup.parseBackupText(backup.serializeBackup(data)), { passphrase: 'correct horse battery' })
  for (const [k, v] of Object.entries(secrets)) assert.equal(opened.keys[k], v, k + ' travels in the secrets block')
  assert.equal(opened.userCredentials[user.id].code, code, 'the access code travels in the secrets block')

  // A safety copy holds the raw store; putting it back must not lose the codes' blob.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-int-'))
  try {
    const file = backup.writeSafetyBackup(store, { safetyDir: dir })
    auth.regenerateCode(store, user.id)
    backup.applyRestore(store, backup.openBackup(backup.parseBackupText(fs.readFileSync(file))), { skipSafety: true })
    assert.equal(auth.findUserByUsernameAndSecret(store, 'kid', code)?.id, user.id, 'the old code works again')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('away-from-home hashes (remote, remoteLogin) are encrypted at rest and travel only as backup secrets', () => {
  const remoteMembers = require(path.join(__dirname, '..', 'electron', 'remoteMembers.js'))
  const store = fakeStore()
  createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  const { user, code } = auth.createUser(store, 'Sam', '')
  auth.setUserRemoteAccess(store, user.id)
  // Signing in at home with their own code keeps the hash the Worker checks away from home.
  assert.equal(auth.findUserByUsernameAndSecret(store, 'sam', code)?.id, user.id)
  const live = auth.getUsers(store)[0]
  assert.match(live.remote.pw_hash, /^[0-9a-f]{64}$/)
  assert.match(live.remoteLogin.pw_hash, /^[0-9a-f]{64}$/)
  const disk = JSON.stringify(store.data)
  assert.ok(!disk.includes(live.remote.pw_hash), 'remote pass hash not in config.json')
  assert.ok(!disk.includes(live.remoteLogin.pw_hash), 'own-password hash not in config.json')
  assert.equal(store.data.authUsers[0].remote, undefined)
  const pushed = remoteMembers.buildMemberList(auth.getUsers(store))
  assert.equal(pushed[0].pw_hash, live.remote.pw_hash)
  assert.equal(pushed[0].login_hash, live.remoteLogin.pw_hash, 'the Worker push still sees both')

  // Without the passphrase option the file carries neither.
  const plain = backup.serializeBackup(backup.createBackup(store, {}))
  assert.ok(!plain.includes(live.remote.pw_hash) && !plain.includes(live.remoteLogin.pw_hash))
  // With it they are inside the encrypted block, and a restore on a new PC re-encrypts them.
  const text = backup.serializeBackup(backup.createBackup(store, { includeSecrets: true, passphrase: 'correct horse battery' }))
  assert.ok(!text.includes(live.remote.pw_hash) && !text.includes(live.remoteLogin.pw_hash))
  const fresh = fakeStore()
  createSecretSettings({ store: fresh, safeStorage: fakeSafeStorage() }).install()
  backup.applyRestore(fresh, backup.openBackup(backup.parseBackupText(text), { passphrase: 'correct horse battery' }), { skipSafety: true })
  const back = auth.getUsers(fresh)[0]
  assert.deepEqual(back.remote, live.remote)
  assert.deepEqual(back.remoteLogin, live.remoteLogin)
  assert.ok(!JSON.stringify(fresh.data).includes(live.remote.pw_hash), 'encrypted again after restore')

  // Turning it off really removes it (an old encrypted copy doesn't come back).
  auth.clearUserRemoteAccess(store, user.id)
  assert.equal(auth.getUsers(store)[0].remote, undefined)
  assert.equal(auth.hasRemoteAccess(auth.getUsers(store)[0]), false)
})

test("webhook signing secrets are encrypted at rest and still readable to sign with", async () => {
  const webhooks = require(path.join(__dirname, "..", "electron", "webhooks.js"))
  const store = fakeStore()
  createSecretSettings({ store, safeStorage: fakeSafeStorage() }).install()
  const made = await webhooks.create(store, { name: "HA", url: "https://93.184.216.34/hook", events: ["request.added"] })
  assert.equal(made.ok, true)
  assert.ok(!JSON.stringify(store.data).includes(made.secret), "no plain signing secret on disk")
  assert.equal(store.data.webhooks[0].name, "HA", "the rest of the record stays readable")
  assert.equal(store.get("webhooks")[0].secret, made.secret, "readers (the dispatcher) get the real value")
  const rotated = webhooks.rotateSecret(store, made.hook.id)
  assert.ok(!JSON.stringify(store.data).includes(rotated.secret))
  assert.equal(store.get("webhooks")[0].secret, rotated.secret)
})
