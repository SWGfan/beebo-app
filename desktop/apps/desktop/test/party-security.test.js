// Security review F1 (car watch-party rooms), F2 (stored XSS through the party title) and the
// party half of F7 (CSPRNG ids). Run: node --test test/party-security.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { withServer, localRequire } = require('./security-harness')
const partyRoom = localRequire('./electron/partyRoom')
const parental = localRequire('./electron/parentalControls')

test('room codes: 8 characters, unambiguous alphabet, unique, CSPRNG (no Math.random)', () => {
  const seen = new Set()
  for (let i = 0; i < 3000; i++) {
    const c = partyRoom.newCode()
    assert.match(c, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/)
    seen.add(c)
  }
  assert.equal(seen.size, 3000, 'no repeats in 3000 draws')
  // A collision is retried; a full table gives up instead of looping.
  let calls = 0
  const c = partyRoom.newCode(() => ++calls < 5)
  assert.ok(c && calls === 5)
  assert.equal(partyRoom.newCode(() => true), null)
  const src = require('node:fs').readFileSync(require.resolve('../electron/partyRoom.js'), 'utf8')
  assert.equal(/Math\.random/.test(src.replace(/\/\/.*$/gm, '')), false)
  assert.match(partyRoom.newMemberId(), /^m_[A-Za-z0-9_-]{12}$/)
  assert.match(partyRoom.newJoinKey(), /^[A-Za-z0-9_-]{16}$/)
})

test('legacy 4-digit codes and near-misses never normalise into a room', () => {
  assert.equal(partyRoom.normalizeCode('1234'), '')
  assert.equal(partyRoom.normalizeCode('0000000O'), '', '0 and O are not in the alphabet')
  assert.equal(partyRoom.normalizeCode('ABCDEFGI'), '', 'I is not in the alphabet')
  assert.equal(partyRoom.normalizeCode(' k7m2-9pqr '), 'K7M29PQR', 'case, spaces and dashes are forgiven')
  assert.equal(partyRoom.normalizeCode({ toString() { return 'K7M29PQR' } }), 'K7M29PQR')
  assert.equal(partyRoom.normalizeCode(null), '')
})

test('cleanText strips markup characters, controls and line separators, and caps by characters', () => {
  const hostile = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', 'a' + String.fromCharCode(0x2028) + 'b' + String.fromCharCode(0x2029) + 'c',
    'x' + String.fromCharCode(0) + 'y' + String.fromCharCode(0x202e) + 'z']
  for (const h of hostile) {
    const out = partyRoom.cleanText(h, 200)
    assert.doesNotMatch(out, /[<>]/)
    assert.ok(![...out].some((ch) => { const c = ch.charCodeAt(0); return c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x2028 && c <= 0x202e) }), 'no control or separator characters')
  }
  assert.equal(partyRoom.cleanText('  many   spaces  ', 50), 'many spaces')
  assert.equal(partyRoom.cleanText('x'.repeat(500), 200).length, 200)
  assert.equal(partyRoom.cleanText(undefined, 10), '')
  assert.equal(partyRoom.escapeHtml('<a href="x">&\'`'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&#96;')
})

test('join failures lock an address out; a success does not reset the count', () => {
  let t = 1000
  const limiter = parental.createPinLimiter({ max: 10, windowMs: 15 * 60 * 1000, now: () => t })
  const party = partyRoom.createParty({ pinLimiter: limiter, now: () => t })
  for (let i = 0; i < 9; i++) party.fail('9.9.9.9')
  assert.equal(party.locked('9.9.9.9'), 0)
  const { room } = party.startFor('u1', 'Host')
  assert.ok(party.addGuest(room, 'Guest')) // an attacker joining their own room...
  party.fail('9.9.9.9') // ...does not earn the tenth guess back
  assert.ok(party.locked('9.9.9.9') > 0)
  assert.equal(party.locked('8.8.8.8'), 0, 'other addresses are unaffected')
  t += 16 * 60 * 1000
  assert.equal(party.locked('9.9.9.9'), 0, 'the lockout ends')
})

test('a room closes when the host goes quiet, at the age cap, and on stop; one room per owner', () => {
  let t = 1000
  const party = partyRoom.createParty({ now: () => t })
  const a = party.startFor('u1', 'Dad').room
  assert.equal(party.startFor('u1', 'Dad2').room, a, 'same room while it lives')
  assert.equal(a.hostName, 'Dad2')
  assert.equal(party.get(a.code), a)
  t += partyRoom.PARTY_IDLE_HOST_MS - 1000
  a.hostSeen = t // the host reports again
  t += partyRoom.PARTY_IDLE_HOST_MS - 1000
  assert.equal(party.get(a.code), a)
  t += 2000
  assert.equal(party.get(a.code), null, 'host silent for 15 minutes: gone')
  const b = party.startFor('u1', 'Dad').room
  assert.notEqual(b.code, a.code)
  assert.equal(party.closeForOwner('u1'), true)
  assert.equal(party.get(b.code), null)
  // guests are capped
  const c = party.startFor('u2', 'Mum').room
  let added = 0
  while (party.addGuest(c, 'g')) added++
  assert.equal(added, partyRoom.MAX_MEMBERS - 1)
})

test('party over HTTP: link needs code AND key, roster/state/stream need a guest token, host stop ends it', async () => {
  await withServer({ getPublicName: () => 'nick' }, async ({ api, raw, server }) => {
    const forged = { host: 'evil.example', 'x-forwarded-host': 'evil.example' }
    let r = await api('POST', '/api/party/start', { hostName: 'Dad' }, forged)
    assert.equal(r.status, 200)
    const { code, joinKey, joinUrl } = r.json
    assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/)
    assert.match(joinKey, /^[A-Za-z0-9_-]{16}$/)
    assert.doesNotMatch(joinUrl, /evil\.example/, 'the invite link is built from OUR names, not the Host header')
    assert.match(joinUrl, /^https:\/\/nick\.beebo\.tv\/api\/party\/join\?c=/)
    assert.ok(joinUrl.endsWith('c=' + code + '&k=' + joinKey))

    // Host publishes a hostile title.
    const id = server.encodeId('Clip (2020).mp4')
    const title = '<img src=x onerror=alert(1)>"><script>alert(2)</script>'
    r = await api('POST', '/api/party/state', { code, streamPath: '/file?id=' + encodeURIComponent(id), title, position: 3, playing: true })
    assert.equal(r.status, 200)

    // Wrong key, right code; right key, wrong code; a legacy 4-digit code: all the same refusal.
    const join = (body) => raw({ method: 'POST', pathname: '/api/party/guest', headers: { 'content-type': 'application/json' }, body })
    for (const body of [{ code, name: 'x' }, { code, key: 'A'.repeat(16), name: 'x' }, { code: 'ZZZZZZZZ', key: joinKey, name: 'x' }, { code: '1234', key: joinKey, name: 'x' }]) {
      r = await join(body)
      assert.equal(r.status, 404)
      assert.doesNotMatch(r.text, new RegExp(code))
    }

    // Unauthenticated peeking at a room is over.
    for (const u of ['/api/party/state?code=' + code, '/api/party/roster?code=' + code, '/api/party/stream?code=' + code]) {
      r = await raw({ pathname: u })
      assert.ok(r.status === 404 || r.status === 403, u + ' -> ' + r.status)
      assert.doesNotMatch(r.text, /Dad|Clip/)
    }

    // A proper join, with a hostile name.
    r = await join({ code: code.toLowerCase(), key: joinKey, name: '<b onmouseover=alert(1)>Sam' })
    assert.equal(r.status, 200)
    const g = r.json.g
    assert.ok(r.json.members.every((m) => !/[<>]/.test(m.name)))
    r = await raw({ pathname: '/api/party/state?code=' + code + '&g=' + encodeURIComponent(g) })
    assert.equal(r.status, 200)
    assert.equal(r.json.playing, true)
    assert.doesNotMatch(r.json.title, /[<>]/, 'the title is stored without markup characters')
    assert.match(r.json.title, /alert\(2\)/, 'the text survives, inert')
    const stream = await raw({ pathname: r.json.streamPath + '&g=' + encodeURIComponent(g), headers: { range: 'bytes=0-9' } })
    assert.ok(stream.status === 200 || stream.status === 206)
    // A token for another room's code is worthless.
    r = await raw({ pathname: '/api/party/state?code=ZZZZZZZZ&g=' + encodeURIComponent(g) })
    assert.equal(r.status, 404)

    // The join page: values from the URL never become markup, and no guest-visible value is
    // written with innerHTML.
    const page = await raw({ pathname: '/api/party/join?c=' + code + '&k=' + joinKey })
    assert.equal(page.status, 200)
    assert.equal(page.headers['referrer-policy'], 'no-referrer')
    assert.doesNotMatch(page.text, /innerHTML/)
    assert.match(page.text, new RegExp('var CODE="' + code + '",KEY="' + joinKey + '"'))
    const bad = await raw({ pathname: '/api/party/join?c=%22%3Balert(1)%2F%2F&k=%3Cscript%3E' })
    assert.doesNotMatch(bad.text, /alert\(1\)|<script>alert/)
    assert.match(bad.text, /var CODE="",KEY=""/)

    // Host stops the party: the room, and every guest token, die at once.
    r = await api('POST', '/api/party/stop', {})
    assert.equal(r.json.closed, true)
    r = await raw({ pathname: '/api/party/state?code=' + code + '&g=' + encodeURIComponent(g) })
    assert.equal(r.status, 404)
    r = await raw({ pathname: '/api/party/stream?code=' + code + '&g=' + encodeURIComponent(g) })
    assert.equal(r.status, 403)
  })
})

test('ten wrong join attempts lock the address out, even for the right link', async () => {
  await withServer({}, async ({ api, raw }) => {
    const { code, joinKey } = (await api('POST', '/api/party/start', {})).json
    const join = (body) => raw({ method: 'POST', pathname: '/api/party/guest', headers: { 'content-type': 'application/json' }, body })
    for (let i = 0; i < 10; i++) assert.equal((await join({ code: 'ABCDEFGH'.replace('A', '2'), key: 'B'.repeat(16), name: 'x' })).status, 404)
    const r = await join({ code, key: joinKey, name: 'Sam' })
    assert.equal(r.status, 429)
    assert.equal(r.json.error, 'locked')
  })
})
