'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { redact, redactIps } = require('../electron/logRedact')

// Secrets are assembled at run time so this file itself never holds a live-looking value.
const HEX32 = 'a1b2c3d4'.repeat(4)
const B64_43 = 'Zx9-Qm2_LkP7vT4nR8sW1yU6cE3bH5jA0dGfIoXhNqM'.slice(0, 43)
const PAT = 'beebo_pat_' + 'ab12cd34ef56' + '_' + B64_43
const JWT = ['eyJhbGciOiJFZERTQSJ9', 'eyJ0eXBlIjoidHJpYWwiLCJleHAiOjE5OTk5OTk5OTl9', 'c2lnbmF0dXJlLWJ5dGVzLWhlcmUtMTIzNDU2'].join('.')
const MT = 'mt' + 'Zm9vYmFyLW1lZGlhLXRva2VuLTEyMzQ1Ng'
const APP_PW = 'abcd efgh ijkl mnop'
const LICENCE = 'K7QM-92XD-PLA4-WZ58'

function assertGone(out, ...secrets) {
  for (const s of secrets) assert.ok(!out.includes(s), 'leaked: ' + s + '\n' + out)
}

test('bearer tokens and Authorization headers, in every spelling', () => {
  const lines = [
    'Authorization: Bearer ' + B64_43,
    'authorization=Bearer ' + JWT,
    '"Authorization":"Bearer ' + B64_43 + '"',
    "headers: { authorization: 'Basic dXNlcjpwYXNzd29yZA==' }",
    'AUTHORIZATION: token ' + HEX32,
    'sending request with header bearer ' + B64_43 + ' to worker'
  ]
  for (const l of lines) {
    const out = redact(l)
    assertGone(out, B64_43, JWT, 'dXNlcjpwYXNzd29yZA==', HEX32)
    assert.match(out, /\[redacted\]/, l)
  }
})

test('cookies and session values', () => {
  const out = redact('Cookie: beebo_session=' + B64_43 + '; theme=dark; other=1\nSet-Cookie: beebo_session=' + B64_43 + '; HttpOnly')
  assertGone(out, B64_43)
  assert.ok(!out.includes('theme=dark'), 'the whole Cookie line goes, not just the first cookie')
})

test('query-string secrets: token=, mt=, pat_, api_key, code, and friends', () => {
  const urls = [
    '/api/stream?file=x&token=' + B64_43,
    'GET /video/abc?mt=' + MT + '&t=12 200',
    'https://beebo.tv/api/x?api_key=' + HEX32 + '&language=en',
    '/media/1.m3u8?access_token=' + B64_43 + '#frag',
    '/pair?code=' + LICENCE + '&invite=' + HEX32,
    'http://127.0.0.1:47811/a?apikey=' + HEX32 + '&sig=' + B64_43,
    '/x?TOKEN=' + B64_43,
    '/x?emailAppPassword=' + encodeURIComponent(APP_PW)
  ]
  for (const u of urls) assertGone(redact(u), B64_43, MT, HEX32, LICENCE, encodeURIComponent(APP_PW), 'Zm9vYmFy')
  assert.match(redact('/api/stream?file=x&token=abc123def'), /file=x&token=\[redacted\]/)
  assert.equal(redact('/api/list?season=1&episode=2&format=json'), '/api/list?season=1&episode=2&format=json', 'ordinary parameters are left alone')
})

test('Beebo API tokens (pat_) and licence tokens', () => {
  const out = redact('created key ' + PAT + ' for the household, licence ' + JWT)
  assertGone(out, PAT, 'ab12cd34ef56', B64_43, JWT)
  assert.match(out, /pat_\[redacted\]/)
  assertGone(redact('activation ok ' + PAT.replace('beebo_', '')), B64_43)
})

test('passwords, keys and secrets in JSON, logfmt, JS object dumps and errors', () => {
  const samples = [
    '{"password":"hunter2 with spaces","user":"nick"}',
    "{ password: 'hunter2 with spaces', user: 'nick' }",
    'password=hunter2withoutspaces',
    'emailAppPassword: ' + APP_PW,
    'emailAppPassword=' + APP_PW + ' host=smtp.gmail.com',
    '{"tmdbApiKey":"' + HEX32 + '"}',
    'openSubtitlesPassword = "p@ss w0rd!"',
    'sessionSecret: ' + B64_43,
    'licenseKey=' + LICENCE,
    'license_key: "' + LICENCE + '"',
    'client_secret=' + B64_43 + '&grant_type=x',
    'Error: login failed for pw=hunter2 pwd:hunter2',
    'rtcRelay { kind: "turn", secret: "' + B64_43 + '" }'
  ]
  for (const s of samples) {
    const out = redact(s)
    assertGone(out, 'hunter2', APP_PW, 'abcd', HEX32, LICENCE, B64_43, 'p@ss', 'w0rd')
    assert.match(out, /\[redacted\]/, s)
  }
  const out = redact('emailAppPassword=' + APP_PW + ' host=smtp.gmail.com')
  assert.match(out, /host=smtp\.gmail\.com/, 'text after the secret survives')
})

test('the four-group licence key and long opaque strings are hidden even with no label', () => {
  assertGone(redact('trying ' + LICENCE + ' against the server'), LICENCE)
  assertGone(redact('blob ' + B64_43 + ' end'), B64_43)
  assertGone(redact('sha ' + HEX32), HEX32)
})

test('credentials inside URLs', () => {
  const out = redact('fetching https://nick:s3cr3tpass@ftp.example.com/feed and smtp://user:pw@mail.example.org:587')
  assertGone(out, 's3cr3tpass', 'user:pw')
  assert.match(out, /ftp\.example\.com\/feed/)
})

test('email addresses, other people\'s IPs, and the Windows user name in paths', () => {
  const out = redact('viewer alice.smith@example.com from 203.0.113.77 and 2001:db8:85a3:0:0:8a2e:370:7334 via 192.168.1.20 and 127.0.0.1 opened C:\\Users\\Sample240\\AppData\\Roaming\\Beebo\\config.json and C:\\\\Users\\\\Sample240\\\\x')
  assertGone(out, 'alice.smith@example.com', '203.0.113.77', '2001:db8', 'Sample240')
  assert.match(out, /<email>/)
  assert.match(out, /192\.168\.1\.20/)
  assert.match(out, /127\.0\.0\.1/)
  assert.match(out, /C:\\Users\\<user>\\AppData/)
  assert.equal(redact('electron 31.7.7 build 10.0.19045 time 12:34:56'), 'electron 31.7.7 build 10.0.19045 time 12:34:56', 'versions and timestamps are not IPs')
  assert.equal(redactIps('fe80::1 and fd12:3456::1 and ::1'), 'fe80::1 and fd12:3456::1 and ::1', 'local IPv6 stays')
})

test('diagnostics mode hides library folders and media file names', () => {
  const out = redact('GET /api/stream?file=The%20Movie%20(2001).mkv 200; scanning D:\\Beebo\\Movies\\Some Film (1999)\\Some Film.mp4 and d:/beebo/movies/x/y.mkv', { libraryRoots: ['D:\\Beebo\\Movies'], files: true })
  assertGone(out, 'The%20Movie', 'Some Film', 'y.mkv', 'Beebo\\Movies')
  assert.match(out, /<library-path>/)
})

test('literals (user and computer names) are removed wherever they appear', () => {
  assertGone(redact('host SAMPLE-DESKTOP user sample240', { literals: ['Sample-Desktop', 'Sample240'] }), 'SAMPLE-DESKTOP', 'sample240')
})

test('idempotent: redacting twice equals redacting once', () => {
  const s = 'token=' + B64_43 + ' Authorization: Bearer ' + JWT + ' ' + PAT + ' password: "x y" ' + APP_PW
  const once = redact(s)
  assert.equal(redact(once), once)
})

test('does not eat ordinary log text', () => {
  const plain = [
    '[remote-host] agent exited code=0 signal=null after 812s',
    '[stream] listening on 0.0.0.0:47811',
    '[home-address] nick.home.beebo.tv -> 192.168.1.5 (up to date)',
    '[updater 2026-09-21T10:00:00.000Z] up to date at 0.1.57',
    'scan finished: 1043 movies, 1311 episodes in 4.2s',
    '[convert] job 7 done'
  ]
  for (const p of plain) assert.equal(redact(p), p)
})

test('hostile input: huge lines finish quickly and are capped', () => {
  const started = Date.now()
  const cases = [
    'a'.repeat(200000),
    'token='.repeat(30000),
    ('x'.repeat(50) + ' ').repeat(4000),
    '?' + 'a=b&'.repeat(50000),
    ':'.repeat(100000) + '1',
    ('1.'.repeat(30000)) + '1',
    'password' + '_'.repeat(100000),
    'A-'.repeat(60000),
    'Cookie:' + ' x'.repeat(100000)
  ]
  for (const c of cases) {
    const out = redact(c)
    assert.ok(out.length < 9000 + 60, 'line cap applied')
  }
  assert.ok(Date.now() - started < 4000, 'took ' + (Date.now() - started) + 'ms')
})

test('non-strings do not throw', () => {
  assert.equal(redact(null), '')
  assert.equal(redact(undefined), '')
  assert.equal(redact(42), '42')
})
