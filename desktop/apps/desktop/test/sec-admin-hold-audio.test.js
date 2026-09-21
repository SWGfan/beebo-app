'use strict'
// Security review A-05: the owner's "admins must use two-factor" hold did not cover the routes that are matched
// ABOVE the bearer gate in handleApiRequest (Music, Audiobooks, Podcasts, Radio) or the public /api/v1 API.
// An admin who had not set two-factor up could still, with a token made before the policy, POST
// /api/radio/settings { allowPrivateNetwork: true } (opens the radio relay to the home network) or change the
// podcast settings; /api/movies etc. answered 403 two_factor_setup_required as they should.
//
// Fixed in electron/streamServer.js (handleApiRequest and resolvePublicPrincipal). The "not held" tests must keep passing.
// Run: node --test test/sec-admin-hold-audio.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { withServer } = require('./security-harness')


async function setup(fn) {
  await withServer({}, async (ctx) => {
    // A second admin-less member, to show the hold is only for the admin.
    const made = ctx.auth.createUser(ctx.store, 'Member', 'member@example.com').user
    const memberToken = ctx.server.makeApiToken(ctx.store, made.id)
    await fn({ ...ctx, memberToken })
  })
}
const bearerOf = (token) => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' })

test('A-05 baseline: without the policy an admin and a member reach the audio libraries', async () => {
  await setup(async ({ api, raw, memberToken }) => {
    assert.equal((await api('GET', '/api/podcasts/status')).status, 200)
    assert.equal((await api('GET', '/api/radio/settings')).status, 200)
    assert.equal((await api('GET', '/api/audiobooks/status')).status, 200)
    assert.equal((await raw({ method: 'GET', pathname: '/api/podcasts/status', headers: bearerOf(memberToken) })).status, 200)
  })
})

test('A-05: under the admin two-factor hold the audio libraries answer two_factor_setup_required, like every other route', async () => {
  await setup(async ({ api, raw, store, memberToken }) => {
    store.set('requireTwoFactorForAdmins', true)
    const movies = await api('GET', '/api/movies')
    assert.equal(movies.status, 403, 'control: the ordinary routes are held')
    assert.equal(movies.json.error, 'two_factor_setup_required')
    for (const [method, p, body] of [
      ['GET', '/api/podcasts/status'],
      ['POST', '/api/podcasts/settings', { refreshMinutes: 30 }],
      ['GET', '/api/radio/settings'],
      ['POST', '/api/radio/settings', { allowPrivateNetwork: true }],
      ['GET', '/api/audiobooks/status'],
      ['POST', '/api/audiobooks/rescan', {}]
    ]) {
      const r = await api(method, p, body)
      assert.equal(r.status, 403, method + ' ' + p + ' should be held, got ' + r.status)
      assert.equal(r.json && r.json.error, 'two_factor_setup_required', method + ' ' + p)
    }
    assert.notEqual(store.get('radioSettings') && store.get('radioSettings').allowPrivateNetwork, true, 'the setting was not changed')
    // A member (not an admin) is not held.
    assert.equal((await raw({ method: 'GET', pathname: '/api/podcasts/status', headers: bearerOf(memberToken) })).status, 200)
  })
})

test('A-05: the public /api/v1 API is held for an admin too (account token)', async () => {
  await setup(async ({ api, store }) => {
    store.set('requireTwoFactorForAdmins', true)
    const r = await api('GET', '/api/v1')
    assert.equal(r.status, 403)
    assert.equal(r.json && r.json.error, 'two_factor_setup_required')
  })
})
