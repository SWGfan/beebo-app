// Jellyfin-compatible API hardening: repeated query parameters, tracked and revocable app sessions, app passwords for
// two-factor accounts, Quick Connect approval from the desktop, the WebSocket at /socket, Suggestions / Similar / Next Up,
// stable DateCreated, media segments and the owner's self-check.
// Run: node --test test/jellyfin-hardening.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const crypto = require('node:crypto')
const { fixture, localRequire } = require('./jellyfin-fixture')
const { mediaFixture, SKIP } = require('./jellyfin-media-fixture')
const { createFrameReader, encodeFrame, OP } = localRequire('./electron/jellyfin/websocket')
const { createAppPasswords, looksLikeAppPassword } = localRequire('./electron/jellyfin/appPasswords')

const admin = (f) => f.info.jellyfin

// A minimal masked-frame WebSocket client, enough to speak to /socket.
function wsConnect(f, query, headers = {}) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request(f.base + '/socket' + query, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...headers } })
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }) })
    req.on('upgrade', (res, socket, head) => {
      const messages = []
      const closes = []
      const waiters = []
      const reader = (() => {
        let buf = Buffer.alloc(0)
        return (chunk) => {
          buf = Buffer.concat([buf, chunk])
          for (;;) {
            if (buf.length < 2) return
            let len = buf[1] & 0x7f
            let off = 2
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
            if (buf.length < off + len) return
            const op = buf[0] & 0x0f
            const payload = buf.subarray(off, off + len)
            buf = buf.subarray(off + len)
            if (op === OP.TEXT) { const m = JSON.parse(payload.toString('utf8')); messages.push(m); for (const w of waiters.splice(0)) w() } else if (op === OP.CLOSE) { closes.push(payload.length >= 2 ? payload.readUInt16BE(0) : 1005); for (const w of waiters.splice(0)) w() }
          }
        }
      })()
      if (head && head.length) reader(head)
      socket.on('data', reader)
      socket.on('error', () => {})
      const send = (obj, { unmasked = false, raw } = {}) => {
        const body = raw || Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))
        const mask = crypto.randomBytes(4)
        const m = unmasked ? 0 : 0x80
        let head
        if (body.length < 126) head = Buffer.from([0x81, m | body.length])
        else if (body.length < 65536) head = Buffer.from([0x81, m | 126, body.length >> 8, body.length & 0xff])
        else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = m | 127; head.writeBigUInt64BE(BigInt(body.length), 2) }
        const payload = Buffer.from(body)
        if (!unmasked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
        socket.write(Buffer.concat([head, unmasked ? Buffer.alloc(0) : mask, payload]))
      }
      const waitFor = async (pred, ms = 4000) => {
        const end = Date.now() + ms
        for (;;) {
          const hit = messages.find(pred)
          if (hit) return hit
          if (Date.now() > end) throw new Error('timed out waiting for a message; got ' + JSON.stringify(messages.map((m) => m.MessageType)))
          await new Promise((r) => { waiters.push(r); setTimeout(r, 100) })
        }
      }
      const waitClose = async (ms = 4000) => {
        const end = Date.now() + ms
        while (!closes.length) {
          if (Date.now() > end) throw new Error('no close frame')
          await new Promise((r) => { waiters.push(r); setTimeout(r, 100) })
        }
        return closes[0]
      }
      resolve({ status: 101, res, socket, messages, send, waitFor, waitClose, acceptHeader: res.headers['sec-websocket-accept'], key, close: () => { try { socket.destroy() } catch {} } })
    })
    req.on('error', () => resolve({ status: 0 }))
    req.end()
  })
}

test('frames: the RFC 6455 reader handles masking, fragments, lengths and refuses bad input', () => {
  const frames = []
  const errors = []
  const push = createFrameReader({ onFrame: (f) => frames.push(f), onError: (c) => errors.push(c), maxMessage: 1000 })
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = (op, fin, text) => {
    const body = Buffer.from(text)
    const out = Buffer.from(body)
    for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3]
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | body.length]), mask, out])
  }
  push(masked(1, true, 'hello'))
  assert.equal(frames[0].payload.toString(), 'hello')
  const two = Buffer.concat([masked(1, false, 'ab'), masked(0, true, 'cd')])
  push(two.subarray(0, 5))
  push(two.subarray(5))
  assert.equal(frames[1].payload.toString(), 'abcd', 'fragments are joined, and a frame split across reads is reassembled')
  const p2 = createFrameReader({ onFrame: () => {}, onError: (c) => errors.push(c) })
  p2(Buffer.from([0x81, 0x05, 104, 101, 108, 108, 111]))
  assert.deepEqual(errors, [1002], 'an unmasked client frame is a protocol error')
  const p3 = createFrameReader({ onFrame: () => {}, onError: (c) => errors.push(c), maxMessage: 10 })
  p3(Buffer.from([0x81, 0x80 | 126, 0x01, 0x00, 1, 2, 3, 4]))
  assert.equal(errors[1], 1009, 'a message over the limit is refused before it is read')
  const enc = encodeFrame(OP.TEXT, 'x'.repeat(300))
  assert.equal(enc[1], 126)
  assert.equal(enc.readUInt16BE(2), 300)
  assert.equal(encodeFrame(OP.PING, '').length, 2)
})

test('lenient headers: Apple-style clients that omit Client / DeviceId (or send no Authorization header at all) can still sign in and Quick Connect', async () => {
  const f = await fixture()
  try {
    const noApp = await fetch(f.base + '/Users/AuthenticateByName', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'MediaBrowser Device="Apple TV", Version="8.5"' }, body: JSON.stringify({ Username: 'robin', Pw: 'adult-password-1' }) })
    assert.equal(noApp.status, 200, 'no Client and no DeviceId')
    const bare = await fetch(f.base + '/Users/AuthenticateByName', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Username: 'robin', Pw: 'adult-password-1' }) })
    assert.equal(bare.status, 200, 'no Authorization header at all')
    const token = (await bare.json()).AccessToken
    assert.equal((await fetch(f.base + '/Users/Me', { headers: { authorization: 'MediaBrowser Token="' + token + '"' } })).status, 200, 'a header with only the token')
    assert.equal((await fetch(f.base + '/QuickConnect/Initiate', { method: 'POST', headers: { authorization: 'MediaBrowser Client="Infuse"' } })).status, 200, 'Quick Connect without a DeviceId')
    // A non-administrator does everything an app does at first connect without hitting an admin-only wall.
    for (const p of ['/System/Info', '/Users', '/Sessions', '/Devices', '/Users/Me', '/UserViews', '/DisplayPreferences/usersettings?client=emby']) {
      assert.equal((await fetch(f.base + p, { headers: { authorization: 'MediaBrowser Token="' + token + '"' } })).status, 200, p)
    }
    assert.equal((await fetch(f.base + '/Playback/BitrateTest?size=2048', { headers: { authorization: 'MediaBrowser Token="' + token + '"' } })).status, 200)
    assert.equal((await (await fetch(f.base + '/playback/bitratetest?size=2048', { headers: { authorization: 'MediaBrowser Token="' + token + '"' } })).arrayBuffer()).byteLength, 2048, 'lower-case path, as some add-ons write it')
    assert.equal((await fetch(f.base + '/Auth/Keys/' + encodeURIComponent('somebody-elses-token'), { method: 'DELETE', headers: { authorization: 'MediaBrowser Token="' + token + '"' } })).status, 403, 'an app can only end its own sign-in')
    assert.equal((await fetch(f.base + '/Auth/Keys/' + encodeURIComponent(token), { method: 'DELETE', headers: { authorization: 'MediaBrowser Token="' + token + '"' } })).status, 204)
    assert.equal((await fetch(f.base + '/Users/Me', { headers: { authorization: 'MediaBrowser Token="' + token + '"' } })).status, 401)
  } finally { await f.close() }
})

test('query: repeated parameters and comma lists mean the same list', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const both = await f.jf('GET', '/Items?includeItemTypes=Movie&includeItemTypes=Series&recursive=true', { token: t })
    const csv = await f.jf('GET', '/Items?includeItemTypes=Movie,Series&recursive=true', { token: t })
    assert.equal(both.status, 200)
    assert.deepEqual(both.json.Items.map((i) => i.Id).sort(), csv.json.Items.map((i) => i.Id).sort())
    assert.ok(both.json.Items.some((i) => i.Type === 'Movie') && both.json.Items.some((i) => i.Type === 'Series'), 'both types came back')
  } finally { await f.close() }
})

test('sessions: every sign-in is a tracked session the owner can list and sign out, and Logout really ends it', async () => {
  const f = await fixture()
  try {
    const authSessions = localRequire('./electron/authSessions')
    const login = await f.jf('POST', '/Users/AuthenticateByName', { token: '', body: { Username: 'robin', Pw: 'adult-password-1' }, headers: {} })
    assert.equal(login.status, 200)
    const token = login.json.AccessToken
    assert.match(token, /^jf\./)
    const mine = authSessions.list(f.store, 'u-adult')
    assert.equal(mine.length, 1)
    assert.equal(mine[0].method, 'jellyfin')
    const listed = admin(f).sessions()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].userId, 'u-adult')
    assert.equal(listed[0].app, 'TestClient')
    assert.equal(listed[0].device, 'Test TV')
    assert.equal(listed[0].signedInWith, 'Password')
    assert.equal((await f.jf('GET', '/Users/Me', { token })).status, 200)
    assert.equal(admin(f).revokeSession('u-adult', listed[0].id).ok, true)
    assert.equal((await f.jf('GET', '/Users/Me', { token })).status, 401, 'the owner signed that app out: the token is dead at once')
    assert.equal(admin(f).sessions().length, 0)
    // Logout from the app itself is persistent too (not a memory list that a restart forgets).
    const again = (await f.jf('POST', '/Users/AuthenticateByName', { token: '', body: { Username: 'robin', Pw: 'adult-password-1' } })).json.AccessToken
    assert.equal(authSessions.list(f.store, 'u-adult').length, 1)
    assert.equal((await f.jf('POST', '/Sessions/Logout', { token: again, body: {} })).status, 204)
    assert.equal(authSessions.list(f.store, 'u-adult').length, 0, 'the tracked session record is gone')
    assert.equal((await f.jf('GET', '/Users/Me', { token: again })).status, 401)
    // The sessions list of an app shows only that person's own apps.
    await f.signIn('owner')
    await f.signIn('adult')
    const mineOnly = await f.jf('GET', '/Sessions', { token: f.tokens.adult })
    assert.ok(mineOnly.json.every((s) => s.UserName === 'Robin'))
  } finally { await f.close() }
})

test('app passwords: two-factor accounts are refused a password sign-in and use a per-app password instead', async () => {
  const f = await fixture()
  try {
    // Turn two-factor on for Robin (the shape twoFactor.isEnabled reads).
    f.data.authUsers = f.data.authUsers.map((u) => (u.id === 'u-adult' ? { ...u, twoFactor: { enabled: true, secret: 'JBSWY3DPEHPK3PXP', recovery: [] } } : u))
    const refused = await f.login('robin', 'adult-password-1')
    assert.equal(refused.status, 401)
    assert.match(refused.json.Message, /two-factor/i)
    assert.match(refused.json.Message, /app password/i, 'the message says what to do instead')
    // The owner makes one for that app (Settings > Jellyfin apps).
    const made = admin(f).createAppPassword('u-adult', 'Living room Apple TV')
    assert.equal(made.ok, true)
    assert.match(made.secret, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/)
    assert.equal(looksLikeAppPassword(made.secret), true)
    assert.ok(!JSON.stringify(f.data.jellyfinAppPasswords).includes(made.secret.replace(/-/g, '')), 'only a hash is stored')
    const ok = await f.login('robin', made.secret)
    assert.equal(ok.status, 200)
    assert.equal((await f.jf('GET', '/Users/Me', { token: ok.json.AccessToken })).json.Name, 'Robin')
    assert.equal(admin(f).sessions().find((s) => s.userId === 'u-adult').signedInWith, 'App password')
    // Lower case and no dashes are accepted (people retype it on a TV).
    assert.equal((await f.login('robin', made.secret.toLowerCase().replace(/-/g, ''))).status, 200)
    // It is not a password anywhere else.
    const beebo = await fetch(f.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'robin', password: made.secret }) })
    assert.equal(beebo.status, 401, 'Beebo\'s own sign-in does not accept an app password')
    // Deleting it ends it for the next sign-in.
    assert.equal(admin(f).removeAppPassword(made.item.id).ok, true)
    assert.equal((await f.login('robin', made.secret)).status, 401)
    // Wrong guesses are throttled.
    const second = admin(f).createAppPassword('u-adult', 'Second')
    const bad = second.secret.slice(0, -1) + (second.secret.endsWith('A') ? 'B' : 'A')
    let last = 0
    for (let i = 0; i < 12; i++) last = (await f.login('robin', bad)).status
    assert.equal(last, 429, 'after enough wrong app passwords the address is locked out')
    assert.equal((await f.login('robin', second.secret)).status, 429, 'even the right one waits while locked')
  } finally { await f.close() }
})

test('app passwords: unit rules (label, limits, hash-only, throttle window)', () => {
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v } }
  let t = 1000
  const ap = createAppPasswords({ store, now: () => t })
  assert.equal(ap.create('u1', '').ok, false)
  for (let i = 0; i < 20; i++) assert.equal(ap.create('u1', 'app ' + i).ok, true)
  assert.equal(ap.create('u1', 'one more').ok, false, 'a person is capped')
  const made = ap.create('u2', 'x')
  assert.equal(ap.verify({ userId: 'u2', username: 'b', ip: '1.1.1.1', secret: made.secret }).ok, true)
  assert.equal(ap.verify({ userId: 'u3', username: 'c', ip: '1.1.1.1', secret: made.secret }).ok, false)
  for (let i = 0; i < 9; i++) ap.verify({ userId: 'u2', username: 'b', ip: '9.9.9.9', secret: 'AAAA-BBBB-CCCC-DDDD' })
  assert.equal(ap.verify({ userId: 'u2', username: 'b', ip: '9.9.9.9', secret: made.secret }).limited, true)
  t += 16 * 60 * 1000
  assert.equal(ap.verify({ userId: 'u2', username: 'b', ip: '9.9.9.9', secret: made.secret }).ok, true, 'the window ages out')
})

test('Quick Connect: the owner approves a code from the desktop and the app signs in as that person', async () => {
  const f = await fixture()
  try {
    const init = await f.jf('POST', '/QuickConnect/Initiate', { token: '', headers: {} })
    assert.equal(init.status, 200)
    const { Code, Secret } = init.json
    assert.match(Code, /^\d{6}$/)
    const pending = admin(f).quickConnectPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].code, Code)
    assert.equal(pending[0].app, 'TestClient')
    assert.ok(!('secret' in pending[0]), 'the list never carries the secret')
    assert.equal((await f.jf('GET', '/QuickConnect/Connect?secret=' + Secret, { token: null })).json.Authenticated, false)
    assert.equal(admin(f).approveQuickConnect('12345', 'u-adult').ok, false, 'a short code is refused')
    assert.equal(admin(f).approveQuickConnect('000000', 'u-adult').ok, false, 'an unknown code is refused')
    const ok = admin(f).approveQuickConnect(Code, 'u-adult')
    assert.equal(ok.ok, true)
    assert.equal((await f.jf('GET', '/QuickConnect/Connect?secret=' + Secret, { token: null })).json.Authenticated, true)
    const redeemed = await f.jf('POST', '/Users/AuthenticateWithQuickConnect', { token: null, body: { Secret } })
    assert.equal(redeemed.status, 200)
    assert.equal(redeemed.json.User.Name, 'Robin', 'the device is signed in as the person the owner chose')
    assert.equal(admin(f).sessions().find((s) => s.userId === 'u-adult').signedInWith, 'Quick Connect')
    assert.equal(admin(f).quickConnectPending().length, 0)
    assert.equal((await f.jf('POST', '/Users/AuthenticateWithQuickConnect', { token: null, body: { Secret } })).status, 401, 'a code works once')
    for (let i = 0; i < 12; i++) admin(f).approveQuickConnect('999999', 'u-adult')
    assert.equal(admin(f).approveQuickConnect('999999', 'u-adult').error, 'too_many_wrong', 'wrong codes are throttled')
  } finally { await f.close() }
})

test('websocket: strict sign-in, keep-alive, sessions and UserDataChanged pushes, and hard limits', async () => {
  const f = await fixture()
  const opened = []
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    assert.equal((await wsConnect(f, '')).status, 401, 'no token, no socket')
    assert.equal((await wsConnect(f, '?api_key=jf.nope.1.abc')).status, 401, 'a bad token, no socket')
    assert.equal((await wsConnect(f, '?api_key=' + encodeURIComponent(t), { 'Sec-WebSocket-Version': '8' })).status, 400, 'wrong version')
    const plain = await f.jf('GET', '/socket', { token: null })
    assert.equal(plain.status, 426, 'a plain GET is told to upgrade')

    const ws = await wsConnect(f, '?api_key=' + encodeURIComponent(t) + '&deviceId=tv-1')
    opened.push(ws)
    assert.equal(ws.status, 101)
    assert.equal(ws.acceptHeader, crypto.createHash('sha1').update(ws.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'))
    const force = await ws.waitFor((m) => m.MessageType === 'ForceKeepAlive')
    assert.equal(force.Data, 60)
    assert.match(force.MessageId, /^[0-9a-f-]{36}$/)
    ws.send({ MessageType: 'KeepAlive' })
    await ws.waitFor((m) => m.MessageType === 'KeepAlive')
    ws.send({ MessageType: 'SessionsStart', Data: '0,1000' })
    const sessions = await ws.waitFor((m) => m.MessageType === 'Sessions')
    assert.ok(Array.isArray(sessions.Data) && sessions.Data.every((s) => s.UserName === 'Robin'), 'only the person\'s own sessions')
    ws.send({ MessageType: 'SessionsStop' })
    ws.send({ MessageType: 'ScheduledTasksInfoStart', Data: '0,1000' }) // admin-only in Jellyfin: ignored, not an error
    ws.send('not json at all')
    // A mark from another app reaches this socket.
    const toy = (await f.jf('GET', '/Items?SearchTerm=toy&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    assert.equal((await f.jf('POST', '/UserPlayedItems/' + toy.Id, { token: t })).status, 200)
    const changed = await ws.waitFor((m) => m.MessageType === 'UserDataChanged')
    assert.equal(changed.Data.UserDataList[0].ItemId, toy.Id)
    assert.equal(changed.Data.UserDataList[0].Played, true)
    assert.equal(changed.Data.UserId, (await f.jf('GET', '/Users/Me', { token: t })).json.Id)

    // Somebody else's socket never gets it.
    await f.signIn('owner')
    const other = await wsConnect(f, '?api_key=' + encodeURIComponent(f.tokens.owner))
    opened.push(other)
    await f.jf('POST', '/UserPlayedItems/' + toy.Id, { token: t })
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(!other.messages.some((m) => m.MessageType === 'UserDataChanged'), 'another person is not told')

    // Protocol violations close the socket with the right code.
    const raw = await wsConnect(f, '?api_key=' + encodeURIComponent(t))
    opened.push(raw)
    raw.send('hello', { unmasked: true })
    assert.equal(await raw.waitClose(), 1002)
    const big = await wsConnect(f, '?api_key=' + encodeURIComponent(t))
    opened.push(big)
    big.send('', { raw: Buffer.alloc(70000, 65) })
    assert.equal(await big.waitClose(), 1009)

    // Signing the app out closes its socket at the next check, and the mode switched off refuses new ones.
    f.data.jellyfinCompat = false
    assert.equal((await wsConnect(f, '?api_key=' + encodeURIComponent(t))).status, 404)
  } finally { for (const w of opened) w.close && w.close(); await f.close() }
})

test('websocket: a person can hold only a handful of sockets', async () => {
  const f = await fixture()
  const opened = []
  try {
    await f.signIn('adult')
    const q = '?api_key=' + encodeURIComponent(f.tokens.adult)
    let refused = 0
    for (let i = 0; i < 10; i++) {
      const w = await wsConnect(f, q)
      if (w.status === 101) opened.push(w)
      else refused++
    }
    assert.equal(opened.length, 8)
    assert.equal(refused, 2)
  } finally { for (const w of opened) w.close(); await f.close() }
})

test('browse: Suggestions, Similar, Next Up (enableResumable), stable DateCreated and ETags, playlists view', async () => {
  const f = await fixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    // Suggestions is its own route (not an item id), returns unwatched films and shows, and stops suggesting what was watched.
    let r = await f.jf('GET', '/Items/Suggestions?type=Movie&limit=10', { token: t })
    assert.equal(r.status, 200)
    assert.ok(r.json.Items.length >= 3)
    assert.ok(r.json.Items.every((i) => i.Type === 'Movie'))
    const toy = r.json.Items.find((i) => i.Name === 'Toy Story')
    assert.ok(toy)
    await f.jf('POST', '/UserPlayedItems/' + toy.Id, { token: t })
    r = await f.jf('GET', '/Items/Suggestions?type=Movie&limit=10', { token: t })
    assert.ok(!r.json.Items.some((i) => i.Id === toy.Id), 'a watched film is not suggested')
    assert.equal((await f.jf('GET', '/Users/' + (await f.jf('GET', '/Users/Me', { token: t })).json.Id + '/Suggestions', { token: t })).status, 200, 'the older path answers too')

    // Similar: same kind, sharing genres, never itself. (Toy Story and Paddington are both animation/comedy.)
    r = await f.jf('GET', '/Items/' + toy.Id + '/Similar?limit=5', { token: t })
    assert.equal(r.status, 200)
    assert.ok(r.json.Items.some((i) => i.Name === 'Paddington'))
    assert.ok(!r.json.Items.some((i) => i.Id === toy.Id))
    assert.ok(!r.json.Items.some((i) => i.Name === 'Heat'), 'no genre in common')
    assert.equal((await f.jf('GET', '/Movies/' + toy.Id + '/Similar', { token: t })).status, 200)

    // DateCreated is present, stays the same across a catalog refresh, and the ETag only moves when the item changes.
    const first = (await f.jf('GET', '/Items/' + toy.Id, { token: t })).json
    assert.ok(first.DateCreated, 'DateCreated')
    assert.match(first.DateCreated, /^\d{4}-\d\d-\d\dT/)
    await new Promise((r2) => setTimeout(r2, 50))
    const stored = f.data.jellyfinFirstSeen
    assert.ok(stored === undefined || typeof stored === 'object')
    const second = (await f.jf('GET', '/Items/' + toy.Id, { token: t })).json
    assert.equal(second.DateCreated, first.DateCreated)
    assert.equal(second.Etag, first.Etag)
    const latest = (await f.jf('GET', '/Items/Latest?includeItemTypes=Movie', { token: t })).json
    assert.ok(latest.every((i) => i.DateCreated))
    const other = (await f.jf('GET', '/Items?SearchTerm=heat&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    assert.notEqual(other.Etag, first.Etag)

    // Views: no Playlists view until the person has a playlist.
    const views = (await f.jf('GET', '/UserViews', { token: t })).json.Items
    assert.ok(!views.some((v) => v.CollectionType === 'playlists'))

    // Next Up: the episode after the last finished one, with enableResumable=false leaving part-watched ones to Resume.
    const series = (await f.jf('GET', '/Items?SearchTerm=bluey&IncludeItemTypes=Series&Recursive=true', { token: t })).json.Items[0]
    const eps = (await f.jf('GET', '/Shows/' + series.Id + '/Episodes', { token: t })).json.Items
    assert.ok(eps.length >= 3)
    await f.jf('POST', '/UserPlayedItems/' + eps[0].Id, { token: t })
    let next = (await f.jf('GET', '/Shows/NextUp?enableResumable=false', { token: t })).json
    assert.equal(next.Items.length, 1)
    assert.equal(next.Items[0].Id, eps[1].Id, 'the next one in order')
    await f.jf('POST', '/Sessions/Playing/Progress', { token: t, body: { ItemId: eps[1].Id, PlaySessionId: 'x', PositionTicks: 300000000 } })
    const resumable = (await f.jf('GET', '/Shows/NextUp', { token: t })).json.Items
    const notResumable = (await f.jf('GET', '/Shows/NextUp?enableResumable=false', { token: t })).json.Items
    assert.ok(resumable.length >= notResumable.length)
    assert.ok(!notResumable.some((i) => i.UserData && i.UserData.PlaybackPositionTicks > 0), 'part-watched episodes are only in Resume')
  } finally { await f.close() }
})

test('segments (unit): intro and credits markers become Intro / Outro with ticks, types can be filtered, junk is dropped', async () => {
  const { createSegments } = localRequire('./electron/jellyfin/segments')
  const ids = { encode: (k, v) => k + ':' + v }
  const entry = { type: 'Movie', jid: 'jid1', beeboId: 'b1' }
  const mk = (effective, duration = 3600) => createSegments({
    ids,
    host: { api: async () => ({ status: 200, body: { ok: true, effective } }) },
    services: { playback: { beeboInfo: async () => ({ durationSec: duration }) } }
  })
  const q = (list = []) => Object.assign(() => '', { list: () => list })
  let out = await mk({ introStartSeconds: 12, introEndSeconds: 92, creditsStartSeconds: 3400 }).forEntry({ id: 'u' }, entry, q(), {})
  assert.deepEqual(out.map((s) => [s.Type, s.StartTicks, s.EndTicks]), [['Intro', 120000000, 920000000], ['Outro', 34000000000, 36000000000]])
  assert.ok(out.every((s) => s.ItemId === 'jid1' && typeof s.Id === 'string'))
  out = await mk({ introEndSeconds: 60 }).forEntry({ id: 'u' }, entry, q(), {})
  assert.deepEqual(out.map((s) => [s.Type, s.StartTicks]), [['Intro', 0]], 'no start known: the intro runs from 0')
  out = await mk({ introEndSeconds: 60, creditsStartSeconds: 3400 }).forEntry({ id: 'u' }, entry, q(['Outro']), {})
  assert.deepEqual(out.map((s) => s.Type), ['Outro'])
  out = await mk({ creditsStartSeconds: 5000 }).forEntry({ id: 'u' }, entry, q(), {})
  assert.deepEqual(out, [], 'credits after the end are dropped')
  assert.deepEqual(await mk(null).forEntry({ id: 'u' }, entry, q(), {}), [])
  assert.deepEqual(await mk({ introEndSeconds: 60 }).forEntry({ id: 'u' }, { type: 'Series', jid: 's' }, q(), {}), [], 'only films and episodes have segments')
})

test('segments: markers saved in Beebo come out as Intro media segments over HTTP', { skip: SKIP, timeout: 120000 }, async () => {
  const f = await mediaFixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const clip = (await f.jf('GET', '/Items?SearchTerm=clip&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    let r = await f.jf('GET', '/MediaSegments/' + clip.Id, { token: t })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.Items, [], 'no markers yet: an empty list, not an error')
    // Someone (any viewer) saves markers in Beebo; the detector's results use the same store.
    const tok = f.server.makeApiToken(f.store, 'u-adult')
    const beeboId = Buffer.from('Clip (2020).mp4').toString('base64url')
    // Beebo's own guard: an intro may be at most 25% of a known runtime (this clip is 100 s).
    const set = await fetch(f.base + '/api/markers', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ kind: 'movie', id: beeboId, introEndSeconds: 20, durationSeconds: 100 }) })
    assert.equal(set.status, 200)
    r = await f.jf('GET', '/MediaSegments/' + clip.Id, { token: t })
    assert.deepEqual(r.json.Items.map((s) => s.Type), ['Intro'])
    const intro = r.json.Items[0]
    assert.equal(intro.StartTicks, 0)
    assert.equal(intro.EndTicks, 200000000)
    assert.equal(intro.ItemId, clip.Id)
    assert.match(intro.Id, /^[0-9a-f]{32}$/)
    r = await f.jf('GET', '/MediaSegments/' + clip.Id + '?includeSegmentTypes=Outro', { token: t })
    assert.deepEqual(r.json.Items, [])
    const detail = (await f.jf('GET', '/Items/' + clip.Id, { token: t })).json
    assert.equal(detail.MediaSources[0].HasSegments, true)
    assert.equal((await f.jf('GET', '/MediaSegments/01000000000000000000000000000001', { token: t })).status, 404)
  } finally { await f.close() }
})

test('trickplay + chapters: a preview sheet is built from Beebo\'s frames and the item says how to use it', { skip: SKIP, timeout: 180000 }, async () => {
  const f = await mediaFixture()
  try {
    await f.signIn('adult')
    const t = f.tokens.adult
    const clip = (await f.jf('GET', '/Items?SearchTerm=clip&IncludeItemTypes=Movie&Recursive=true', { token: t })).json.Items[0]
    // Beebo makes the preview frames on first use; wait for them.
    let detail = null
    for (let i = 0; i < 60; i++) {
      detail = (await f.jf('GET', '/Items/' + clip.Id, { token: t })).json
      if (detail.Trickplay) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    assert.ok(detail.Trickplay, 'the item advertises trickplay once the frames exist')
    const bySource = detail.Trickplay[clip.Id]
    const widths = Object.keys(bySource)
    assert.equal(widths.length, 1)
    const info = bySource[widths[0]]
    assert.equal(info.Width, Number(widths[0]))
    assert.equal(info.TileWidth, 10)
    assert.equal(info.TileHeight, 10)
    assert.ok(info.Height > 0 && info.ThumbnailCount >= 10 && info.Interval >= 1000)
    const sheet = await f.jf('GET', '/Videos/' + clip.Id + '/Trickplay/' + widths[0] + '/0.jpg?MediaSourceId=' + clip.Id, { token: t, raw: true })
    assert.equal(sheet.status, 200)
    assert.equal(sheet.headers.get('content-type'), 'image/jpeg')
    assert.equal(sheet.buf[0], 0xff)
    assert.equal(sheet.buf[1], 0xd8)
    // The sheet is TileWidth x TileHeight thumbnails wide/high.
    const { jpegSize } = localRequire('./electron/jellyfin/trickplay')
    const dims = jpegSize(sheet.buf)
    assert.equal(dims.width, info.Width * 10)
    assert.ok(dims.height > 0 && dims.height <= info.Height * 10)
    assert.equal((await f.jf('GET', '/Videos/' + clip.Id + '/Trickplay/' + widths[0] + '/999.jpg', { token: t, raw: true })).status, 404, 'no such sheet')
    assert.equal((await f.jf('GET', '/Videos/' + clip.Id + '/Trickplay/12345/0.jpg', { token: t, raw: true })).status, 404, 'no such width')
    assert.equal((await fetch(f.base + '/Videos/' + clip.Id + '/Trickplay/' + widths[0] + '/0.jpg')).status, 401, 'signed-in only')
    const m3u8 = await f.jf('GET', '/Videos/' + clip.Id + '/Trickplay/' + widths[0] + '/tiles.m3u8', { token: t, raw: true })
    assert.equal(m3u8.status, 200)
    assert.match(m3u8.text, /^#EXTM3U/)
    assert.match(m3u8.text, /#EXT-X-TILES:RESOLUTION=\d+x\d+,LAYOUT=10x10,DURATION=/)
    assert.match(m3u8.text, /\n0\.jpg/)
  } finally { await f.close() }
})

test('music apps: what Gelly and Finamp need from a track, lower-case paths, trailing slashes and the file route', { skip: SKIP, timeout: 120000 }, async () => {
  const f = await mediaFixture()
  try {
    const login = await fetch(f.base + '/users/authenticatebyname', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ Username: 'robin', Pw: 'adult-password-1' }) })
    assert.equal(login.status, 200, 'the path is matched without regard to case')
    const t = (await login.json()).AccessToken
    const viewId = (await (await fetch(f.base + '/UserViews', { headers: { 'x-emby-token': t } })).json()).Items.find((v) => v.CollectionType === 'music').Id
    // Gelly loads every Audio item and skips one that lacks any of these fields.
    const page = await (await fetch(f.base + '/Items?parentId=' + viewId + '&IncludeItemTypes=Audio&sortBy=DateCreated&sortOrder=Descending&recursive=true&fields=DateCreated,Genres&ImageTypeLimit=1&EnableImageTypes=Primary&StartIndex=0&Limit=250', { headers: { 'x-emby-token': t } })).json()
    assert.equal(page.TotalRecordCount, 2)
    for (const s of page.Items) {
      assert.ok(s.Name && s.Id && s.RunTimeTicks > 0, 'Name, Id, RunTimeTicks')
      assert.ok(s.AlbumArtists.length && s.AlbumArtists[0].Id && s.AlbumArtists[0].Name, 'AlbumArtists')
      assert.ok(s.ArtistItems.length && s.ArtistItems[0].Id, 'ArtistItems')
      assert.equal(typeof s.UserData.PlayCount, 'number')
      assert.equal(s.HasLyrics, false)
      assert.ok(Array.isArray(s.Genres) && s.Genres.includes('Rock'))
      assert.ok(s.DateCreated)
    }
    const song = page.Items[0]
    // Finamp plays the file itself, with the token as ApiKey.
    const part = await fetch(f.base + '/Items/' + song.Id + '/File?ApiKey=' + encodeURIComponent(t), { headers: { Range: 'bytes=0-99' } })
    assert.equal(part.status, 206)
    assert.equal((await part.arrayBuffer()).byteLength, 100)
    assert.equal((await fetch(f.base + '/Items/' + song.Id + '/File')).status, 401)
    // Reports answer with an empty body (Finamp throws on anything else); a trailing slash is fine.
    const rep = await fetch(f.base + '/Sessions/Playing/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-emby-token': t }, body: JSON.stringify({ ItemId: song.Id, PlaySessionId: 'g1', PositionTicks: 0, CanSeek: true, IsPaused: false }) })
    assert.equal(rep.status, 204)
    assert.equal((await rep.text()), '')
    assert.equal((await fetch(f.base + '/Playlists/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-emby-token': t }, body: JSON.stringify({ Name: 'x' }) })).status, 403)
    const mix = await (await fetch(f.base + '/Items/' + song.Id + '/InstantMix?limit=5&enableImages=true&enableImageTypes=Primary,Disc,Thumb,Art', { headers: { 'x-emby-token': t } })).json()
    assert.equal(mix.Items[0].Id, song.Id)
    const byGenre = await (await fetch(f.base + '/Items?IncludeItemTypes=MusicAlbum&Recursive=true&GenreIds=' + (await (await fetch(f.base + '/MusicGenres', { headers: { 'x-emby-token': t } })).json()).Items[0].Id, { headers: { 'x-emby-token': t } })).json()
    assert.equal(byGenre.Items.length, 1, 'albums of a music genre')
  } finally { await f.close() }
})

test('self-check: says plainly what works, and what does not when the mode is off', async () => {
  const f = await fixture({ compat: false })
  try {
    const off = await admin(f).selfTest()
    assert.equal(off.ok, false)
    assert.equal(off.checks[0].id, 'enabled')
    assert.equal(off.checks[0].state, 'fail')
    assert.match(off.checks[0].hint, /Turn on/)
    f.data.jellyfinCompat = true
    const on = await admin(f).selfTest()
    const bad = on.checks.filter((c) => c.state === 'fail')
    assert.deepEqual(bad.map((c) => c.id + ': ' + c.detail), [], 'nothing fails on a healthy server')
    assert.equal(on.ok, true)
    for (const id of ['info', 'quickconnect', 'me', 'views', 'items', 'detail', 'playback', 'resume', 'nextup', 'latest', 'suggestions', 'socket']) assert.ok(on.checks.some((c) => c.id === id), id + ' was checked')
    assert.match(on.summary, /^All \d+ checks passed/)
    assert.ok(on.checks.every((c) => typeof c.label === 'string' && c.label.length > 5), 'every line reads as a sentence')
    // The check leaves no trace: no watch history, no session record.
    assert.equal(admin(f).sessions().length, 0)
  } finally { await f.close() }
})
