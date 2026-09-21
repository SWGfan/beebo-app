import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initialState, reduce, parseStartReply, displayUri, isTerminal, secondsLeft, runPairing, createTransport,
  finishApproved, START_PATH, POLL_PATH, MAX_POLL_FAILURES, exchangeViewerToken, isSafeExchangeOrigin, EXCHANGE_PATH
} from '../app/js/pairing.js'

const DEVICE = 'A'.repeat(43)
const startBody = () => ({
  device_code: DEVICE, user_code: 'ABCD-EFGH', verification_uri: 'https://beebo.tv/tv',
  verification_uri_complete: 'https://beebo.tv/tv?code=ABCD-EFGH', expires_in: 600, interval: 5
})
const waiting = (now = 1000) => reduce(reduce(initialState(), { type: 'start' }), { type: 'start_ok', body: startBody(), now })

test('parseStartReply accepts the tvPair.js shape', () => {
  const p = parseStartReply(startBody())
  assert.equal(p.userCode, 'ABCD-EFGH')
  assert.equal(p.deviceCode, DEVICE)
  assert.equal(p.verificationUri, 'https://beebo.tv/tv')
  assert.equal(p.expiresInSec, 600)
  assert.equal(p.intervalSec, 5)
})

test('parseStartReply rejects unusable replies', () => {
  assert.equal(parseStartReply(null), null)
  assert.equal(parseStartReply({}), null)
  assert.equal(parseStartReply({ ...startBody(), device_code: '' }), null)
  assert.equal(parseStartReply({ ...startBody(), user_code: '' }), null)
  assert.equal(parseStartReply({ ...startBody(), user_code: '<b>x</b>' }), null)
  assert.equal(parseStartReply({ ...startBody(), verification_uri: 'javascript:alert(1)' }), null)
  assert.equal(parseStartReply({ ...startBody(), verification_uri: 'http://beebo.tv/tv' }), null) // must be https
  assert.equal(parseStartReply({ ...startBody(), device_code: 'has space' }), null)
})

test('parseStartReply clamps hostile expiry/interval', () => {
  const p = parseStartReply({ ...startBody(), expires_in: 99999999, interval: 0 })
  assert.equal(p.expiresInSec, 1800)
  assert.equal(p.intervalSec, 1)
  const q = parseStartReply({ ...startBody(), expires_in: 'x', interval: 'y' })
  assert.equal(q.expiresInSec, 600)
  assert.equal(q.intervalSec, 5)
})

test('displayUri', () => {
  assert.equal(displayUri('https://beebo.tv/tv?code=ABCD'), 'beebo.tv/tv')
  assert.equal(displayUri('https://beebo.tv/'), 'beebo.tv')
})

test('start -> waiting stores code, uri, expiry and interval', () => {
  const s = waiting(1000)
  assert.equal(s.phase, 'waiting')
  assert.equal(s.userCode, 'ABCD-EFGH')
  assert.equal(s.expiresAt, 1000 + 600 * 1000)
  assert.equal(s.intervalMs, 5000)
  assert.equal(secondsLeft(s, 1000), 600)
  assert.equal(secondsLeft(s, 1000 + 599500), 1)
})

test('bad start reply -> error; feature off -> unavailable (404 fall-back to typed sign-in)', () => {
  const bad = reduce(reduce(initialState(), { type: 'start' }), { type: 'start_ok', body: { nope: 1 }, now: 0 })
  assert.equal(bad.phase, 'error')
  const off = reduce(reduce(initialState(), { type: 'start' }), { type: 'start_fail', message: 'x', feature_off: true })
  assert.equal(off.phase, 'unavailable')
  assert.ok(isTerminal(off))
  const net = reduce(reduce(initialState(), { type: 'start' }), { type: 'start_fail', message: 'offline' })
  assert.equal(net.phase, 'error')
  assert.equal(net.error, 'offline')
})

test('pending keeps waiting; slow_down raises the interval (honours server interval, capped at 30 s)', () => {
  let s = waiting()
  s = reduce(s, { type: 'poll_ok', body: { status: 'pending', interval: 5 }, now: 2000 })
  assert.equal(s.phase, 'waiting')
  s = reduce(s, { type: 'poll_ok', body: { status: 'slow_down', interval: 10 }, now: 3000 })
  assert.equal(s.intervalMs, 10000)
  s = reduce(s, { type: 'poll_ok', body: { status: 'slow_down' }, now: 4000 }) // no interval given: +5 s
  assert.equal(s.intervalMs, 15000)
  s = reduce(s, { type: 'poll_ok', body: { status: 'slow_down', interval: 999 }, now: 5000 })
  assert.equal(s.intervalMs, 30000)
  s = reduce(s, { type: 'poll_ok', body: { status: 'slow_down', interval: 2 }, now: 6000 }) // never speeds up
  assert.equal(s.intervalMs, 30000)
})

test('denied and expired are terminal and forget the device code', () => {
  for (const status of ['denied', 'expired']) {
    const s = reduce(waiting(), { type: 'poll_ok', body: { status }, now: 2000 })
    assert.equal(s.phase, status)
    assert.equal(s.deviceCode, '')
    assert.ok(isTerminal(s))
  }
})

test('approved yields the house name and keeps the viewer token OUT of state', () => {
  const s = reduce(waiting(), {
    type: 'poll_ok', now: 2000,
    body: { status: 'approved', name: 'nick', token: 'VIEWER.TOKEN.SECRET', iceServers: [{ urls: 'stun:x' }], expiresAt: 99 }
  })
  assert.equal(s.phase, 'approved')
  assert.equal(s.houseName, 'nick')
  assert.equal(s.deviceCode, '')
  assert.ok(!JSON.stringify(s).includes('SECRET'), 'token must not survive in state')
  assert.deepEqual(finishApproved({ name: 'nick', token: 'T' }), { houseName: 'nick', viewerToken: 'T' })
  assert.deepEqual(finishApproved({ name: 'nick' }), { houseName: 'nick', viewerToken: '' })
  assert.equal(finishApproved({ name: 'nick', token: 'has space' }).viewerToken, '')
  assert.equal(finishApproved({ name: 'nick', token: 'x'.repeat(5000) }).viewerToken, '')
})

test('approved with a bad/missing house name is an error, not a sign-in', () => {
  for (const name of [undefined, '', 'has space', 'a.b', '../x', '<script>', 'x'.repeat(70), 5]) {
    const s = reduce(waiting(), { type: 'poll_ok', body: { status: 'approved', name, token: 't' }, now: 2000 })
    assert.equal(s.phase, 'error', String(name))
  }
})

test('unknown poll status counts as a soft failure and eventually stops', () => {
  let s = waiting()
  for (let i = 0; i < MAX_POLL_FAILURES; i++) s = reduce(s, { type: 'poll_ok', body: { status: 'weird' }, now: 2000 })
  assert.equal(s.phase, 'error')
})

test('poll network failures back off, then give up after MAX_POLL_FAILURES', () => {
  let s = waiting()
  s = reduce(s, { type: 'poll_fail', message: 'boom' })
  assert.equal(s.phase, 'waiting')
  assert.equal(s.intervalMs, 6000)
  for (let i = 1; i < MAX_POLL_FAILURES; i++) s = reduce(s, { type: 'poll_fail', message: 'boom' })
  assert.equal(s.phase, 'error')
  assert.equal(s.error, 'boom')
  // a good poll resets the counter
  let t = reduce(waiting(), { type: 'poll_fail' })
  t = reduce(t, { type: 'poll_ok', body: { status: 'pending' }, now: 1 })
  assert.equal(t.failures, 0)
})

test('local expiry via tick', () => {
  const s = waiting(0)
  assert.equal(reduce(s, { type: 'tick', now: 599999 }).phase, 'waiting')
  assert.equal(reduce(s, { type: 'tick', now: 600000 }).phase, 'expired')
})

test('late events after a terminal state are ignored', () => {
  const done = reduce(waiting(), { type: 'poll_ok', body: { status: 'denied' }, now: 1 })
  assert.equal(reduce(done, { type: 'poll_ok', body: { status: 'approved', name: 'nick' }, now: 2 }).phase, 'denied')
})

// ---- driver ---------------------------------------------------------------------------------

function fakeClock() {
  let now = 0
  const timers = []
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms, dead: false }; timers.push(t); return t },
    clearTimer: (t) => { t.dead = true },
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((t) => !t.dead && t.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        due.dead = true
        due.fn()
        for (let i = 0; i < 20; i++) await Promise.resolve()
      }
      now = target
    },
    pending: () => timers.filter((t) => !t.dead).length
  }
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('driver: polls at the server interval and finishes on approval', async () => {
  const clock = fakeClock()
  const polls = []
  const answers = [{ status: 'pending' }, { status: 'pending' }, { status: 'approved', name: 'nick', token: 'TOK' }]
  const states = []
  const approvals = []
  runPairing({
    start: () => Promise.resolve(startBody()),
    poll: (code) => { polls.push({ code, at: clock.now() }); return Promise.resolve(answers.shift()) },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onState: (s) => states.push(s),
    onApproved: (a) => approvals.push(a)
  })
  await flush()
  assert.equal(polls.length, 0)
  await clock.advance(4999)
  assert.equal(polls.length, 0, 'never polls before the interval')
  await clock.advance(1)
  assert.equal(polls.length, 1)
  await clock.advance(5000)
  await clock.advance(5000)
  assert.equal(polls.length, 3)
  assert.deepEqual(polls.map((p) => p.code), [DEVICE, DEVICE, DEVICE])
  const last = states[states.length - 1]
  assert.equal(last.phase, 'approved')
  assert.equal(last.houseName, 'nick')
  assert.ok(!JSON.stringify(states).includes('TOK'), 'token never reaches a state')
  assert.deepEqual(approvals, [{ houseName: 'nick', viewerToken: 'TOK' }], 'handed over exactly once, via onApproved only')
  assert.equal(clock.pending(), 0, 'no timer left running after a terminal state')
})

test('driver: slow_down widens the polling gap', async () => {
  const clock = fakeClock()
  const polls = []
  runPairing({
    start: () => Promise.resolve(startBody()),
    poll: () => { polls.push(clock.now()); return Promise.resolve(polls.length === 1 ? { status: 'slow_down', interval: 10 } : { status: 'pending' }) },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onState: () => {}
  })
  await flush()
  await clock.advance(5000)
  await clock.advance(9999)
  assert.equal(polls.length, 1)
  await clock.advance(1)
  assert.equal(polls.length, 2)
  assert.equal(polls[1] - polls[0], 10000)
})

test('driver: cancel stops everything', async () => {
  const clock = fakeClock()
  let polls = 0
  const h = runPairing({
    start: () => Promise.resolve(startBody()),
    poll: () => { polls++; return Promise.resolve({ status: 'pending' }) },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onState: () => {}
  })
  await flush()
  h.cancel()
  await clock.advance(60000)
  assert.equal(polls, 0)
})

test('driver: start failure with featureOff -> unavailable, no polling', async () => {
  const clock = fakeClock()
  let polls = 0
  const states = []
  runPairing({
    start: () => Promise.reject(Object.assign(new Error('x'), { featureOff: true })),
    poll: () => { polls++; return Promise.resolve({}) },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onState: (s) => states.push(s)
  })
  await flush()
  await clock.advance(30000)
  assert.equal(states[states.length - 1].phase, 'unavailable')
  assert.equal(polls, 0)
})

test('driver: code expiring locally ends the session without another request', async () => {
  const clock = fakeClock()
  const states = []
  let polls = 0
  runPairing({
    start: () => Promise.resolve({ ...startBody(), expires_in: 30 }),
    poll: () => { polls++; return Promise.resolve({ status: 'pending' }) },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onState: (s) => states.push(s)
  })
  await flush()
  await clock.advance(120000)
  assert.equal(states[states.length - 1].phase, 'expired')
  assert.ok(polls <= 6)
})

// ---- transport ------------------------------------------------------------------------------

test('transport posts to the tvPair.js routes with the device name/model', async () => {
  const calls = []
  const t = createTransport((path, body) => { calls.push([path, body]); return Promise.resolve({ ok: 1 }) }, { deviceName: 'Living room', deviceModel: 'tizen' })
  await t.start()
  await t.poll('CODE')
  assert.deepEqual(calls[0], [START_PATH, { device_name: 'Living room', device_model: 'tizen' }])
  assert.deepEqual(calls[1], [POLL_PATH, { device_code: 'CODE' }])
  assert.equal(START_PATH, '/tvpair/start')
  assert.equal(POLL_PATH, '/tvpair/poll')
})

test('transport: 429 slow_down is a normal answer; 404 marks the feature off; others propagate', async () => {
  const slow = createTransport(() => Promise.reject(Object.assign(new Error('e'), { kind: 'server', status: 429, body: { status: 'slow_down', interval: 10 } })))
  assert.deepEqual(await slow.poll('c'), { status: 'slow_down', interval: 10 })
  const off = createTransport(() => Promise.reject(Object.assign(new Error('e'), { kind: 'not_found', status: 404 })))
  await assert.rejects(off.start(), (e) => e.featureOff === true)
  const bad = createTransport(() => Promise.reject(Object.assign(new Error('e'), { kind: 'server', status: 500 })))
  await assert.rejects(bad.poll('c'), (e) => e.featureOff === undefined)
})

// ---- viewer-token exchange (POST /api/viewer-session) -------------------------------------------

const VT = 'VIEWER.TOKEN.SECRET'
const okBody = { token: 'u1.1900000000000.sig', user: { id: 'u1', name: 'Nick', isAdmin: true }, expiresAt: 1900000000000, server: { name: 'nick' } }
function fakePost(reply) {
  const calls = []
  const post = (origin, path, json, bearer) => {
    calls.push({ origin, path, json, bearer })
    return typeof reply === 'function' ? reply() : Promise.resolve(reply)
  }
  return { post, calls }
}

test('isSafeExchangeOrigin: https anywhere, http only to a private LAN address', () => {
  for (const o of ['https://nick.home.beebo.tv:47811', 'https://8.8.8.8:47811', 'http://192.168.1.20:47811', 'http://10.0.0.2:47811',
    'http://172.20.1.1:47811', 'http://100.70.1.1:47811', 'http://localhost:47811']) assert.equal(isSafeExchangeOrigin(o), true, o)
  for (const o of ['http://nick.home.beebo.tv:47811', 'http://8.8.8.8:47811', 'http://media.example.com', 'ftp://x', '', null,
    'https://', 'http://192.168.1.20.evil.example:47811', 'http://192.168.1.20@evil.example:47811']) assert.equal(isSafeExchangeOrigin(o), false, String(o))
})

test('exchange: success returns the API bearer + user name and never the viewer token', async () => {
  const { post, calls } = fakePost({ status: 200, body: okBody })
  const r = await exchangeViewerToken({ post }, 'https://nick.home.beebo.tv:47811', VT, 'Living room TV')
  assert.equal(r.status, 'signed_in')
  assert.equal(r.token, okBody.token)
  assert.equal(r.userName, 'Nick')
  assert.equal(r.serverName, 'nick')
  assert.ok(!JSON.stringify(r).includes('SECRET'))
  assert.deepEqual(calls[0], { origin: 'https://nick.home.beebo.tv:47811', path: EXCHANGE_PATH, json: { deviceName: 'Living room TV' }, bearer: VT })
  assert.equal(EXCHANGE_PATH, '/api/viewer-session')
})

test('exchange: works over plain http on the LAN, and REFUSES (without sending anything) off-LAN', async () => {
  const lan = fakePost({ status: 200, body: okBody })
  assert.equal((await exchangeViewerToken({ post: lan.post }, 'http://192.168.1.20:47811', VT)).status, 'signed_in')
  assert.deepEqual(lan.calls[0].json, {}) // no deviceName given -> empty body
  const off = fakePost({ status: 200, body: okBody })
  const r = await exchangeViewerToken({ post: off.post }, 'http://nick.home.beebo.tv:47811', VT)
  assert.equal(r.status, 'insecure')
  assert.equal(off.calls.length, 0, 'the viewer token must never be sent over plain http off-LAN')
})

test('exchange: every non-200 answer maps to a fall-back status', async () => {
  const cases = [[404, 'unsupported'], [401, 'rejected'], [403, 'not_allowed'], [429, 'rate_limited'], [500, 'unreachable'], [0, 'unreachable']]
  for (const [status, want] of cases) {
    const { post } = fakePost({ status, body: { error: 'x' } })
    const r = await exchangeViewerToken({ post }, 'https://h.example:47811', VT)
    assert.equal(r.status, want, String(status))
    assert.equal(r.token, undefined)
    assert.ok(!JSON.stringify(r).includes('SECRET'))
  }
})

test('exchange: rejections from the transport (network error / non-2xx errors with status) are classified, not thrown', async () => {
  const net = fakePost(() => Promise.reject(Object.assign(new Error('offline'), { status: 0 })))
  assert.equal((await exchangeViewerToken({ post: net.post }, 'https://h.example', VT)).status, 'unreachable')
  const e404 = fakePost(() => Promise.reject(Object.assign(new Error('nf'), { status: 404 })))
  assert.equal((await exchangeViewerToken({ post: e404.post }, 'https://h.example', VT)).status, 'unsupported')
  const weird = fakePost(() => Promise.reject('boom'))
  assert.equal((await exchangeViewerToken({ post: weird.post }, 'https://h.example', VT)).status, 'unreachable')
  const sync = { post: () => { throw new Error('sync throw') } }
  assert.equal((await exchangeViewerToken(sync, 'https://h.example', VT)).status, 'unreachable')
})

test('exchange: a 200 without a usable token is bad_response; empty viewer token is rejected locally', async () => {
  for (const body of [{}, { token: '' }, { token: 'has space' }, { token: 'x'.repeat(5000) }, { token: 12 }, null]) {
    const { post } = fakePost({ status: 200, body })
    assert.equal((await exchangeViewerToken({ post }, 'https://h.example', VT)).status, 'bad_response', JSON.stringify(body))
  }
  const none = fakePost({ status: 200, body: okBody })
  assert.equal((await exchangeViewerToken({ post: none.post }, 'https://h.example', '')).status, 'rejected')
  assert.equal(none.calls.length, 0)
})

test('exchange: hostile user/server names are sanitised', async () => {
  const { post } = fakePost({ status: 200, body: { token: 'a.b.c', user: { name: 'Ni\u202Ec\u0000k' }, server: { name: { x: 1 } } } })
  const r = await exchangeViewerToken({ post }, 'https://h.example', VT)
  assert.equal(r.userName, 'Nick')
  assert.equal(r.serverName, '')
})

test('full flow with a fake fetch: pair -> approved -> exchange -> signed in (and 404 -> typed sign-in fallback)', async () => {
  for (const [exchangeStatus, expectSignedIn] of [[200, true], [404, false]]) {
    const clock = fakeClock()
    const approvals = []
    runPairing({
      start: () => Promise.resolve(startBody()),
      poll: () => Promise.resolve({ status: 'approved', name: 'nick', token: VT, iceServers: [], expiresAt: 1 }),
      now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, onState: () => {},
      onApproved: (a) => approvals.push(a)
    })
    await flush()
    await clock.advance(5000)
    assert.equal(approvals.length, 1)
    const { post, calls } = fakePost({ status: exchangeStatus, body: exchangeStatus === 200 ? okBody : {} })
    const origin = 'https://' + approvals[0].houseName + '.home.beebo.tv:47811'
    const r = await exchangeViewerToken({ post }, origin, approvals[0].viewerToken, 'TV')
    assert.equal(r.status === 'signed_in', expectSignedIn)
    assert.equal(calls[0].bearer, VT)
    assert.equal(calls[0].origin, 'https://nick.home.beebo.tv:47811')
  }
})
