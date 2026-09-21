'use strict'
// electron/cloudFetch.js: what the app does when the internet is slow or gone.
// Run: node --test test/cloud-fetch.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createCloudFetch, isHomeHost, friendlyNetworkMessage, COSMETIC_HOSTS } = require('../electron/cloudFetch')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const TMDB = 'https://api.themoviedb.org/3/movie/1'
const BEEBO = 'https://login.beebo.tv/validate'

// A fetch that answers as told and honours abort signals like the real one.
function fakeFetch(behaviour) {
  const calls = []
  const impl = (url, init) => {
    const call = { url: String(url), init, aborted: false }
    calls.push(call)
    return new Promise((resolve, reject) => {
      const signal = init && init.signal
      if (signal) signal.addEventListener('abort', () => { call.aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e) }, { once: true })
      const b = typeof behaviour === 'function' ? behaviour(call, calls.length) : behaviour
      if (b === 'hang') return
      if (b && b.error) return reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(b.error), { code: b.error }) }))
      setTimeout(() => resolve({ ok: true, status: (b && b.status) || 200 }), (b && b.after) || 0)
    })
  }
  impl.calls = calls
  return impl
}

test('addresses on this computer or the home network are passed straight through', async () => {
  for (const h of ['localhost', '127.0.0.1', '192.168.1.5', '10.0.0.2', '172.20.1.1', '169.254.3.3', '[::1]', 'nas.local']) assert.equal(isHomeHost(h), true, h)
  for (const h of ['api.themoviedb.org', '8.8.8.8', 'login.beebo.tv', '172.32.0.1']) assert.equal(isHomeHost(h), false, h)
  const real = fakeFetch('hang')
  const { fetch: f } = createCloudFetch({ fetchImpl: real, options: { defaultTimeoutMs: 20 } })
  const p = f('http://192.168.1.5:47811/api/ping')
  await wait(60)
  assert.equal(real.calls[0].init, undefined, 'no signal, no limit: a slow LAN device is not the internet')
  assert.equal(real.calls[0].aborted, false)
  void p
})

test('a public request with no limit of its own gets one, and a dead connection ends instead of hanging', async () => {
  const real = fakeFetch('hang')
  const { fetch: f } = createCloudFetch({ fetchImpl: real, options: { defaultTimeoutMs: 40, cosmeticTimeoutMs: 40 } })
  const t0 = Date.now()
  await assert.rejects(f(BEEBO), (e) => e.message === 'fetch failed' && e.cause.code === 'BEEBO_TIMEOUT')
  assert.ok(Date.now() - t0 < 500)
  assert.equal(real.calls[0].aborted, true)
})

test('a caller that brings its own signal keeps its own limit', async () => {
  const real = fakeFetch('hang')
  const { fetch: f } = createCloudFetch({ fetchImpl: real, options: { defaultTimeoutMs: 20 } })
  const own = AbortSignal.timeout(120)
  const t0 = Date.now()
  await assert.rejects(f(BEEBO, { signal: own }), (e) => e.name === 'AbortError')
  assert.ok(Date.now() - t0 >= 100, 'waited for the caller\'s 120 ms, not our 20 ms')
})

test('the limit ends when the response starts, so a long body is never cut off', async () => {
  const real = fakeFetch({ after: 5 })
  const { fetch: f } = createCloudFetch({ fetchImpl: real, options: { defaultTimeoutMs: 40 } })
  await f('https://example.org/big.bin')
  await wait(120)
  assert.equal(real.calls[0].init.signal.aborted, false)
})

test('an answer from the server, even an error, is not "offline"', async () => {
  const real = fakeFetch({ status: 503 })
  const cf = createCloudFetch({ fetchImpl: real })
  for (let i = 0; i < 3; i++) assert.equal((await cf.fetch(TMDB)).status, 503)
  assert.equal(real.calls.length, 3)
  assert.equal(cf.status().state, 'online')
})

test('look-ups that only decorate: one failure pauses the host, so a page waits once, not forty times', async () => {
  const real = fakeFetch({ error: 'ENOTFOUND' })
  let clock = 1000
  const cf = createCloudFetch({ fetchImpl: real, now: () => clock, options: { pauseStartMs: 10000 } })
  await assert.rejects(cf.fetch(TMDB), (e) => e.cause.code === 'ENOTFOUND')
  assert.equal(real.calls.length, 1)
  for (let i = 0; i < 40; i++) await assert.rejects(cf.fetch(TMDB), (e) => e.cause.code === 'BEEBO_OFFLINE')
  assert.equal(real.calls.length, 1, 'the other forty never left the computer')
  assert.equal(cf.status().state, 'offline')
  assert.deepEqual(cf.status().pausedHosts, ['api.themoviedb.org'])
  // The pause ends: exactly one trial goes out; success means online again.
  clock += 10001
  const swapped = createCloudFetch({ fetchImpl: fakeFetch({ status: 200 }), now: () => clock })
  swapped.noteFail('api.themoviedb.org', 'ENOTFOUND')
  clock += 20000
  assert.equal((await swapped.fetch(TMDB)).status, 200)
  assert.equal(swapped.status().state, 'online')
  assert.deepEqual(swapped.status().pausedHosts, [])
})

test('the pause grows while the network stays gone, and is capped', async () => {
  let clock = 0
  const cf = createCloudFetch({ fetchImpl: fakeFetch({ error: 'ENETUNREACH' }), now: () => clock, options: { pauseStartMs: 10000, pauseMaxMs: 60000 } })
  const waits = []
  for (let i = 0; i < 5; i++) {
    await assert.rejects(cf.fetch(TMDB))
    const until = cf.status().pausedHosts.length ? 1 : 0
    assert.equal(until, 1)
    // find how long the pause lasts by probing forward
    let t = 0
    while (t < 200000) { clock += 1000; t += 1000; try { await cf.fetch(TMDB); break } catch (e) { if (e.cause && e.cause.code !== 'BEEBO_OFFLINE') { waits.push(t); break } } }
  }
  assert.deepEqual(waits.map((w) => Math.round(w / 10000)), [1, 2, 4, 6, 6], 'doubling from 10 s up to the 60 s cap')
})

test('until a host has answered once only one request is in flight, so a dead resolver cannot tie up all the worker threads', async () => {
  const real = fakeFetch('hang')
  const cf = createCloudFetch({ fetchImpl: real, options: { cosmeticTimeoutMs: 60, pauseStartMs: 10000 } })
  const t0 = Date.now()
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => cf.fetch(TMDB)))
  assert.equal(real.calls.length, 1, 'five callers, one connection attempt')
  assert.ok(results.every((r) => r.status === 'rejected'))
  assert.equal(results.filter((r) => r.reason.cause.code === 'BEEBO_TIMEOUT').length, 1)
  assert.equal(results.filter((r) => r.reason.cause.code === 'BEEBO_OFFLINE').length, 4)
  assert.ok(Date.now() - t0 < 1000)
})

test('once a host answers, requests to it run side by side again', async () => {
  const real = fakeFetch({ after: 30 })
  const cf = createCloudFetch({ fetchImpl: real })
  await cf.fetch(TMDB)
  const started = Date.now()
  await Promise.all(Array.from({ length: 5 }, () => cf.fetch(TMDB)))
  assert.equal(real.calls.length, 6)
  assert.ok(Date.now() - started < 120, 'in parallel, not one after another')
})

test('Beebo\'s own service is never paused, so signing in works the moment the internet is back', async () => {
  let n = 0
  const real = fakeFetch(() => (++n <= 3 ? { error: 'ENOTFOUND' } : { status: 200 }))
  const cf = createCloudFetch({ fetchImpl: real })
  for (let i = 0; i < 3; i++) await assert.rejects(cf.fetch(BEEBO))
  assert.equal((await cf.fetch(BEEBO)).status, 200)
  assert.equal(real.calls.length, 4)
  assert.equal(cf.status().state, 'online')
})

test('status(): unknown until something happens, offline after a network failure, online after any answer', async () => {
  let clock = 5000
  const real = fakeFetch((c) => (/fail/.test(c.url) ? { error: 'EAI_AGAIN' } : { status: 200 }))
  const cf = createCloudFetch({ fetchImpl: real, now: () => clock })
  assert.equal(cf.status().state, 'unknown')
  await assert.rejects(cf.fetch('https://fail.example.org/'))
  assert.equal(cf.status().state, 'offline')
  assert.equal(cf.status().lastFailCode, 'EAI_AGAIN')
  clock += 1000
  await cf.fetch('https://ok.example.org/')
  assert.equal(cf.status().state, 'online')
})

test('one server refusing us is not "the internet is down"', async () => {
  const real = fakeFetch({ error: 'ECONNREFUSED' })
  const cf = createCloudFetch({ fetchImpl: real })
  await assert.rejects(cf.fetch('https://some-server.example.org/'))
  assert.equal(cf.status().state, 'unknown')
})

test('the list of decorative hosts holds no Beebo sign-in or licence address', () => {
  for (const h of COSMETIC_HOSTS) assert.doesNotMatch(h, /login\.beebo\.tv|workers\.dev|origin\.beebo\.tv|relay/i, h)
})

test('friendlyNetworkMessage turns network errors into one calm sentence and leaves other errors alone', () => {
  const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
  assert.match(friendlyNetworkMessage(offline), /offline.*home network still works/i)
  assert.equal(friendlyNetworkMessage(new Error('HTTP 404')), '')
})
