'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const policy = require('../electron/desktopSettingsPolicy')
const auth = require('../electron/auth')
const privacy = require('../electron/viewingPrivacy')

function fixture(status = 'approved') {
  const privateUser = { id: 'private-person', username: 'adult', name: 'Adult', status, adult: true, viewingHistoryPrivate: true, passwordHash: auth.hashPassword('correct private password'), privacySessionSalt: 'hidden-salt', resetToken: 'hidden-reset', resetTokenExpires: Date.now() + 60000, remoteLogin: { pw_hash: 'hidden-login' }, remote: { pw_hash: 'hidden-remote', pw_salt: 'hidden-remote-salt', pw_iter: 25000, enabledAt: 1 } }
  const state = { authUsers: [privateUser], watchHistory: [{ userId: privateUser.id, title: 'SECRET MOVIE' }] }
  return { state, get: (key, fallback) => state[key] === undefined ? fallback : state[key], set: (key, value) => { state[key] = value }, delete: key => { delete state[key] } }
}

// Exercise the real registered main-process handler bodies with isolated state.
function handler(name, dependencies) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf("ipcMain.handle('" + name + "'")
  assert.ok(start >= 0)
  const end = source.indexOf('\n})', start) + 3
  let registered
  vm.runInNewContext(source.slice(start, end), { ipcMain: { handle: (_, fn) => { registered = fn } }, desktopSettingsPolicy: policy, auth, beeboInbox: null, ...dependencies })
  return registered
}

test('generic desktop settings cannot disable privacy or replace credentials, including dotted keys', () => {
  for (const key of ['authUsers', 'authUsers.0.viewingHistoryPrivate', 'authUsers.0.passwordHash', 'authUsers.0.privacySessionSalt', 'watchHistory', 'watchHistoryPending', 'encryptedSettings', 'license.token', '__proto__', 'constructor.prototype.authUsers']) {
    const store = fixture()
    const before = JSON.stringify(store.state)
    const write = handler('settings:set', { store })
    const partial = JSON.parse(JSON.stringify({ tmdbApiKey: 'new-value', [key]: false }))
    assert.throws(() => write(null, partial), error => error.code === 'setting_not_allowed', key)
    assert.equal(JSON.stringify(store.state), before, 'mixed request writes nothing')
    assert.deepEqual(privacy.publicHistory(store, store.get('watchHistory')), [])
  }
  for (const partial of [null, [], 'authUsers', 3]) assert.throws(() => policy.writeSettings(fixture(), partial))
})

test('all currently editable general settings remain usable', () => {
  const store = fixture()
  const partial = { tmdbApiKey: 'key', emailUser: 'sender@example.test', emailAppPassword: 'app-password', adminNotifyEmail: 'owner@example.test', otherCredentials: 'owner notes', loginLockoutThreshold: 5, loginAlertThreshold: 30, loginLockoutDurationMinutes: 15, missingSearchEngine: 'google', customSearchSites: [{ id: 'custom', url: 'https://example.test/?q={query}' }], moviesSearchEngine: 'google', tvShowsSearchEngine: 'custom:custom', movieTitleOverrides: { 'movie.mp4': 'Title' } }
  assert.equal(handler('settings:set', { store })(null, partial), true)
  for (const [key, value] of Object.entries(partial)) assert.deepEqual(store.get(key), value)
  assert.equal(privacy.isPrivate(store, 'private-person'), true)
})

test('folder picker rejects sensitive keys before opening a dialog', async () => {
  let opened = 0
  const store = fixture()
  const pick = handler('dialog:pickFolder', { store, dialog: { showOpenDialog: async () => { opened++; return { canceled: false, filePaths: ['C:\\Chosen'] } } } })
  for (const key of ['authUsers', 'authUsers.0.viewingHistoryPrivate', 'license.token', undefined]) {
    await assert.rejects(pick(null, key), error => error.code === 'setting_not_allowed')
  }
  assert.equal(opened, 0)
  for (const key of ['moviesDir', 'tvShowsDir', 'viewerAppDir', 'tmdbCacheDir']) assert.equal(await pick(null, key), 'C:\\Chosen')
  assert.equal(opened, 4)
  assert.equal(privacy.isPrivate(store, 'private-person'), true)
})

test('reactivation never exposes private reset tokens or password/session secrets', () => {
  for (const status of ['approved', 'revoked']) {
    const store = fixture(status)
    const result = handler('auth:reactivateUser', { store })(null, 'private-person')
    assert.equal(result.ok, true)
    assert.equal(result.user.viewingHistoryPrivate, true)
    assert.equal(result.user.passwordHash, true)
    const serialized = JSON.stringify(result)
    for (const secret of ['hidden-reset', 'hidden-salt', 'hidden-login', 'hidden-remote', 'hidden-remote-salt', store.get('authUsers')[0].passwordHash]) assert.ok(!serialized.includes(secret), secret)
    assert.equal(store.get('authUsers')[0].resetToken, 'hidden-reset', 'self-service recovery remains intact')
    assert.equal(privacy.isPrivate(store, 'private-person'), true)
  }
  assert.equal(policy.reactivateUser(fixture(), 'unknown', auth).error, 'not_found')
})
