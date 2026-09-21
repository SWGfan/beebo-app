'use strict'
// Security review A-01: capability values that ride in a URL and were not hidden by logRedact:
//   - a Watch together room code (?wt=), a car-party join key (?k=) and guest token (?g=)
//   - a 2FA login challenge and an owner-PIN unlock token
//   - a private trip link, whose token is the whole credential (/trip/<43 chars>), even when it has no digit
//   - an HLS ticket in the path
const test = require('node:test')
const assert = require('node:assert/strict')
const { redact } = require('../electron/logRedact')

// Assembled at run time so this file holds no live-looking value.
const ROOM = ['0123456789', 'ABCDEFGHJK', 'MNPQRS'].join('')
const KEY = 'Party' + 'Key' + 'Value99'
const GUEST = 'guest' + 'Member.1893000000000.' + 'c2ln'
const CHALLENGE = 'eyJ1IjoiYSJ9' + 'X' + '.c2lnbmF0dXJl'
const UNLOCK = '1893000000000.' + 'abcdefghijklmnopqrstuvwxyz'
// 43 letters, no digit: the generic "long opaque string" rule needs a digit, so only the path rule catches it.
const TRIP_NO_DIGIT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP-_'.slice(0, 43)
const TRIP_WITH_DIGIT = 'Zx9-Qm2_LkP7vT4nR8sW1yU6cE3bH5jA0dGfIoXhNqM'.slice(0, 43)
const HLS = 'tick' + 'et_AbCdEf-1234'

function assertGone(out, ...secrets) {
  for (const s of secrets) assert.ok(!out.includes(s), 'leaked: ' + s + '\n' + out)
}

test('a Watch together room code in ?wt= is hidden', () => {
  const out = redact('GET /watch?id=abc&wt=' + ROOM + ' 200')
  assertGone(out, ROOM)
  assert.match(out, /id=abc/)
})

test('car-party join key (k) and guest token (g) in a query string are hidden', () => {
  const out = redact('GET /api/party/join?c=ABCD&k=' + KEY + ' 200\nGET /api/party/roster?code=ABCD&g=' + GUEST + ' 200')
  assertGone(out, KEY, GUEST)
})

test('a login challenge and an owner-PIN unlock token are hidden in query strings and bodies', () => {
  const out = redact('POST /login/2fa?challenge=' + CHALLENGE + ' body {"challenge":"' + CHALLENGE + '","unlock":"' + UNLOCK + '"}')
  assertGone(out, CHALLENGE, UNLOCK)
})

test('a private trip link token is hidden in the path, digit or no digit', () => {
  for (const tok of [TRIP_NO_DIGIT, TRIP_WITH_DIGIT]) {
    const out = redact('GET /trip/' + tok + ' 200\nGET /trip/' + tok + '/m/3 200')
    assertGone(out, tok)
    assert.match(out, /\/trip\/\[redacted\]/)
    assert.match(out, /\/m\/3/, 'the media index is not a secret and stays')
  }
})

test('an HLS ticket in the path is hidden', () => {
  const out = redact('GET /hls/' + HLS + '/index.m3u8 200')
  assertGone(out, HLS)
  assert.match(out, /\/hls\/\[redacted\]\/index\.m3u8/)
})

test('ordinary text and short single-letter parameters elsewhere are left alone', () => {
  const out = redact('GET /tvshows?show=abc&page=2&sort=name 200 ; the k is fine, g too; unlock later')
  assert.equal(out, 'GET /tvshows?show=abc&page=2&sort=name 200 ; the k is fine, g too; unlock later')
})
