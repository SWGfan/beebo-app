// The desktop Users screen's IPC for parental controls and library sharing (electron/sharingIpc.js).
// Run: node --test test/sharing-ipc.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))

test('presets, admin refusal, PIN, share create/revoke push to beebo.tv', async () => {
  const { registerSharingIpc } = localRequire('./electron/sharingIpc')
  const libraryShares = localRequire('./electron/libraryShares')
  const handlers = {}
  const data = { authUsers: [{ id: 'o', name: 'Nick', status: 'approved', isAdmin: true }, { id: 'k', name: 'Sam', status: 'approved' }] }
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] } }
  let pushes = 0
  registerSharingIpc({
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    store,
    auth: { getUsers: (s) => s.get('authUsers') },
    history: { clearAllHistory: () => 0 },
    pushLibraryShares: async () => { pushes++; return { ok: true } },
    getLibraryFolders: () => ({ movies: ['M:\\Films'], tv: [] }),
  })
  const call = (name, arg) => handlers[name](null, arg)
  assert.equal((await call('parental:set', { userId: 'o', preset: 'kids' })).error, 'admin_profile')
  assert.equal((await call('parental:set', { userId: 'k', preset: 'young', extra: { dailyLimitMinutes: 60 } })).policy.dailyLimitMinutes, 60)
  assert.equal((await call('parental:get')).users.find((u) => u.id === 'k').policy.movieMax, 'G')
  assert.equal((await call('parental:setPin', { pin: '12' })).error, 'bad_pin')
  assert.equal((await call('parental:setPin', { pin: '2468' })).pinSet, true)
  assert.equal((await call('parental:setPin', { clear: true, currentPin: '1111' })).error, 'wrong_pin')
  assert.equal((await call('parental:setPin', { clear: true, currentPin: '2468' })).pinSet, false)

  const list = await call('shares:list')
  assert.equal(list.termsVersion, libraryShares.SHARE_TERMS_VERSION)
  assert.deepEqual(list.folders.movies, ['M:\\Films'])
  assert.equal((await call('shares:create', { guestEmail: 'jo@example.com' })).error, 'consent_required')
  const made = await call('shares:create', { guestEmail: 'jo@example.com', libraries: ['movies'], consent: { accepted: true, termsVersion: list.termsVersion } })
  assert.equal(made.ok, true)
  assert.equal(made.share.consent.ownerUserId, 'o')
  assert.equal(pushes, 1)
  const gone = await call('shares:revoke', { id: made.share.id })
  assert.equal(gone.share.status, 'revoked')
  assert.equal(pushes, 2)
})

test('syncShares applies what beebo.tv answers: acceptance, a guest leaving, the invite code', async () => {
  const libraryShares = localRequire('./electron/libraryShares')
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  const consent = { accepted: true, termsVersion: libraryShares.SHARE_TERMS_VERSION }
  const a = libraryShares.create(store, { guestEmail: 'a@example.com', consent, scope: {} }).share
  const b = libraryShares.create(store, { guestEmail: 'b@example.com', consent, scope: {} }).share
  const c = libraryShares.create(store, { guestEmail: 'c@example.com', consent, scope: {} }).share
  let sent = null
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) }
    return { status: 200, json: async () => ({ ok: true, shares: [
      { shareId: a.id, status: 'accepted', acceptedAt: 1700000000 },
      { shareId: b.id, status: 'left' },
      { shareId: c.id, status: 'pending', code: 'ABCD-EFGH', emailed: false },
    ] }) }
  }
  assert.equal((await libraryShares.syncShares({ store, getName: () => '', getToken: () => 't', fetchImpl })).reason, 'not-ready')
  const out = await libraryShares.syncShares({ store, getName: () => 'nick', getToken: () => 'lic', ownerLabel: "Sam's library", fetchImpl })
  assert.equal(out.ok, true)
  assert.equal(sent.url, 'https://nick.beebo.tv/remote/shares')
  assert.equal(sent.body.token, 'lic')
  assert.equal(sent.body.shares.length, 3)
  assert.ok(!JSON.stringify(sent.body).includes('parental'), 'no scope details leave the house')
  assert.equal(libraryShares.get(store, a.id).status, 'active')
  assert.equal(libraryShares.get(store, b.id).status, 'left')
  assert.equal(libraryShares.get(store, c.id).inviteCode, 'ABCD-EFGH')
  const failing = await libraryShares.syncShares({ store, getName: () => 'nick', getToken: () => 'lic', fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(failing.ok, false, 'never throws')
})
