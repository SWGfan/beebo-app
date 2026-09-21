'use strict'
// electron/cloudFetch.js: the quiet "is the internet back?" probe. Run: node --test test/cloud-fetch-probe.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createCloudFetch, createInternetProbe } = require('../electron/cloudFetch')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const TMDB = 'https://api.themoviedb.org/3/movie/1'

function fakeFetch(behaviour) {
  return (url, init) => new Promise((resolve, reject) => {
    if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    if (behaviour && behaviour.error) return reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(behaviour.error), { code: behaviour.error }) }))
    resolve({ ok: true, status: 200 })
  })
}

function fakeConnect(outcome) {
  const attempts = []
  const connect = (opts) => {
    const sock = new EventEmitter()
    sock.destroyed = false
    sock.destroy = () => { sock.destroyed = true }
    attempts.push(opts)
    const o = typeof outcome === 'function' ? outcome(opts, attempts.length) : outcome
    if (o === 'connect') setImmediate(() => sock.emit('connect'))
    else if (o !== 'hang') setImmediate(() => sock.emit('error', Object.assign(new Error(o), { code: o })))
    return sock
  }
  connect.attempts = attempts
  return connect
}

test('a host that answers marks the internet online and lifts a pause; nothing is sent, the socket is closed at once', async () => {
  const cf = createCloudFetch({ fetchImpl: fakeFetch({ error: 'ENOTFOUND' }) })
  await assert.rejects(cf.fetch(TMDB))
  assert.equal(cf.status().state, 'offline')
  const connect = fakeConnect('connect')
  const probe = createInternetProbe({ cloud: cf, getHosts: () => ['api.themoviedb.org'], connect })
  await probe.runNow()
  assert.deepEqual(connect.attempts, [{ host: 'api.themoviedb.org', port: 443 }])
  assert.equal(cf.status().state, 'online')
  assert.deepEqual(cf.status().pausedHosts, [])
})

test('no host listed means nothing is even attempted', async () => {
  const cf = createCloudFetch({ fetchImpl: fakeFetch({}) })
  const connect = fakeConnect('connect')
  await createInternetProbe({ cloud: cf, getHosts: () => [], connect }).runNow()
  assert.equal(connect.attempts.length, 0)
})

test('a dead network is noticed within the probe\'s own short limit, before any page asks', async () => {
  const cf = createCloudFetch({ fetchImpl: fakeFetch({}) })
  const probe = createInternetProbe({ cloud: cf, getHosts: () => ['api.themoviedb.org'], connect: fakeConnect('hang'), timeoutMs: 40, offlineEveryMs: 60000 })
  const t0 = Date.now()
  await probe.runNow()
  assert.ok(Date.now() - t0 < 500)
  assert.equal(cf.status().state, 'offline')
  // ...so the very first look-up on a computer with no internet answers at once instead of waiting out its own limit.
  const t1 = Date.now()
  await assert.rejects(cf.fetch(TMDB), (e) => e.cause.code === 'BEEBO_OFFLINE')
  assert.ok(Date.now() - t1 < 50)
  probe.stop()
})

test('a refusal from the host is not treated as "no internet"', async () => {
  const cf = createCloudFetch({ fetchImpl: fakeFetch({}) })
  await createInternetProbe({ cloud: cf, getHosts: () => ['api.themoviedb.org'], connect: fakeConnect('ECONNREFUSED') }).runNow()
  assert.equal(cf.status().state, 'unknown')
})

test('while offline it re-checks by itself, and goes quiet once the internet answers', async () => {
  let n = 0
  const cf = createCloudFetch({ fetchImpl: fakeFetch({}) })
  const connect = fakeConnect(() => (++n < 3 ? 'ENETUNREACH' : 'connect'))
  const probe = createInternetProbe({ cloud: cf, getHosts: () => ['api.themoviedb.org'], connect, offlineEveryMs: 15, timeoutMs: 30, firstDelayMs: 5 })
  probe.start()
  await wait(500)
  assert.equal(connect.attempts.length, 3, 'two failures, one success, then quiet')
  assert.equal(cf.status().state, 'online')
  probe.stop()
})
