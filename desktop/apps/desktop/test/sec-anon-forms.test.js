'use strict'
// Security review A-06: the forms anyone can post without signing in had no limit at all.
//   POST /forgot-code      rotated the named person's access code on EVERY post (a stranger who knows the owner's
//                          e-mail address could lock them out of code sign-in for good) and mailed them each time
//   POST /forgot-password  mailed a fresh reset link on every post (inbox flood, mail-server reputation)
//   POST /request-access   stored one more request per post, without bound (config.json is rewritten in full on
//                          every change, so a flood is a disk and CPU exhaustion), and mailed the owner each time
//
// Fixed in electron/streamServer.js (anonFormAllowed). The "a normal person is not affected" test must keep passing.
// Run: node --test test/sec-anon-forms.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { withServer } = require('./security-harness')

const FORM = { 'content-type': 'application/x-www-form-urlencoded' }
const form = (o) => new URLSearchParams(o).toString()
const codeOf = (auth, store, id) => auth.getUsers(store).find((u) => u.id === id).code

test('A-06 baseline: one "forgot my code" / "forgot my password" / "request access" from a normal person still works', async () => {
  await withServer({}, async ({ raw, store, auth, user }) => {
    auth.setUserCode(store, user.id, 'ABCD2345')
    let r = await raw({ method: 'POST', pathname: '/forgot-code', headers: FORM, body: form({ email: 'owner@example.com' }) })
    assert.equal(r.status, 200)
    assert.notEqual(codeOf(auth, store, user.id), 'ABCD2345', 'the first request does make a new code')
    r = await raw({ method: 'POST', pathname: '/forgot-password', headers: FORM, body: form({ email: 'owner@example.com' }) })
    assert.equal(r.status, 200)
    assert.ok(auth.getUsers(store).find((u) => u.id === user.id).resetTokenHash, 'the first request does make a reset link')
    r = await raw({ method: 'POST', pathname: '/request-access', headers: FORM, body: form({ name: 'Sam', email: 'sam@example.com', message: 'hi' }) })
    assert.equal(r.status, 200)
    assert.equal(store.get('accessRequests').length, 1)
  })
})

test('A-06: a stranger cannot keep rotating someone\'s access code with /forgot-code', async () => {
  await withServer({}, async ({ raw, store, auth, user }) => {
    auth.setUserCode(store, user.id, 'ABCD2345')
    const seen = new Set()
    for (let i = 0; i < 12; i++) {
      await raw({ method: 'POST', pathname: '/forgot-code', headers: FORM, body: form({ email: 'owner@example.com' }) })
      seen.add(codeOf(auth, store, user.id))
    }
    assert.ok(seen.size <= 5, 'the code changed ' + seen.size + ' times in 12 posts (limit is 5 an hour)')
  })
})

test('A-06: /forgot-password sends at most a handful of reset links an hour to one person', async () => {
  await withServer({}, async ({ raw, store, auth, user }) => {
    const seen = new Set()
    for (let i = 0; i < 12; i++) {
      await raw({ method: 'POST', pathname: '/forgot-password', headers: FORM, body: form({ email: 'owner@example.com' }) })
      seen.add(auth.getUsers(store).find((u) => u.id === user.id).resetTokenHash)
    }
    assert.ok(seen.size <= 5, 'made ' + seen.size + ' reset links in 12 posts')
  })
})

test('A-06: /request-access cannot be used to grow the settings file without bound', async () => {
  await withServer({}, async ({ raw, store }) => {
    for (let i = 0; i < 40; i++) {
      await raw({ method: 'POST', pathname: '/request-access', headers: FORM, body: form({ name: 'n' + i, email: 'x' + i + '@example.com', message: 'hi' }) })
    }
    const stored = (store.get('accessRequests') || []).length
    assert.ok(stored <= 5, stored + ' requests stored from one address in one hour')
  })
})
