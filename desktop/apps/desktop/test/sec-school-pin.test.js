// Security review 2026-09-21 (L-4): the BeeboSchool report-card PIN.
//  - POST /school/report/reset-pin let ANY signed-in household member (a child's profile included) remove
//    the parents' PIN without knowing it;
//  - POST /school/report/unlock and /set-pin counted no wrong guesses, so a 4-8 digit PIN fell in minutes.
// Run: node --test test/sec-school-pin.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { withServer } = require('./security-harness')

const form = (o) => new URLSearchParams(o).toString()
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

test('only the owner can reset the report PIN, and wrong PIN guesses lock', async () => {
  await withServer({}, async ({ raw, cookie, store, auth }) => {
    const owner = { cookie, ...FORM }
    // The owner sets a PIN.
    let r = await raw({ method: 'POST', pathname: '/school/report/set-pin', headers: owner, body: form({ next: '4821' }) })
    assert.equal(r.status, 302)
    assert.ok(store.get('schoolPinHash'), 'PIN is set')

    // A child's profile (not an admin) signs in.
    const kid = auth.createUser(store, 'Kiddo', 'kid@example.com').user
    const kidCookie = 'beebo_session=' + auth.signSession(store, kid.id)
    r = await raw({ pathname: '/school/report', headers: { cookie: kidCookie } })
    assert.equal(r.status, 200, 'the member really is signed in (sees the PIN gate, not the login page)')
    assert.match(r.text, /report PIN/i)
    r = await raw({ method: 'POST', pathname: '/school/report/reset-pin', headers: { cookie: kidCookie, ...FORM }, body: '' })
    assert.equal(r.status, 302)
    assert.ok(store.get('schoolPinHash'), 'a member cannot clear the parents\' PIN')

    // Guessing: five wrong PINs lock further tries for that person, even with the right one.
    for (let i = 0; i < 5; i++) {
      r = await raw({ method: 'POST', pathname: '/school/report/unlock', headers: { cookie: kidCookie, ...FORM }, body: form({ pin: '000' + i }) })
      assert.match(String(r.headers.location), /pin=bad/)
    }
    r = await raw({ method: 'POST', pathname: '/school/report/unlock', headers: { cookie: kidCookie, ...FORM }, body: form({ pin: '4821' }) })
    assert.match(String(r.headers.location), /pin=bad/, 'locked: the right PIN is not accepted during the lock')
    assert.equal(r.headers['set-cookie'], undefined)

    // The owner (a different person, but the same address) is stopped by the per-address budget too...
    // ...so check the owner's own reset still works: owner reset clears the PIN.
    r = await raw({ method: 'POST', pathname: '/school/report/reset-pin', headers: owner, body: '' })
    assert.equal(r.status, 302)
    assert.equal(store.get('schoolPinHash'), undefined, 'the owner can reset it')
  })
})
