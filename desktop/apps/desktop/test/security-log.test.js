// The owner's security event log: what is recorded, and what is deliberately never written.
// Run: node --test test/security-log.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const securityLog = require(path.join(__dirname, '..', 'electron', 'securityLog.js'))

function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, writes: 0, get: (k, d) => (k in data ? data[k] : d), set(k, v) { this.writes++; data[k] = v }, delete: (k) => { delete data[k] } }
}

test('public addresses are masked, home-network addresses are kept', () => {
  assert.equal(securityLog.maskIp('203.0.113.42'), '203.0.113.0')
  assert.equal(securityLog.maskIp('::ffff:198.51.100.7'), '198.51.100.0')
  assert.equal(securityLog.maskIp('192.168.1.20'), '192.168.1.20')
  assert.equal(securityLog.maskIp('10.0.0.5'), '10.0.0.5')
  assert.equal(securityLog.maskIp('127.0.0.1'), '127.0.0.1')
  assert.equal(securityLog.maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::')
  assert.equal(securityLog.maskIp('not an ip'), null)
  assert.equal(securityLog.maskIp(''), null)
  assert.equal(securityLog.maskIp('999.1.1.1'), null)
})

test('a username that is not a real account is never written (someone may have pasted a password into it)', () => {
  const store = fakeStore()
  securityLog.record(store, { type: 'login_failed', username: 'hunter2-my-real-password', known: false, ip: '203.0.113.9' })
  securityLog.record(store, { type: 'login_failed', username: 'ann', known: true, ip: '203.0.113.9' })
  const events = securityLog.list(store)
  assert.equal(events[0].username, 'ann')
  assert.equal(events[1].username, null)
  assert.ok(!JSON.stringify(events).includes('hunter2'))
})

test('free text is passed through the log redactor: passwords, tokens, cookies and emails never land', () => {
  const store = fakeStore()
  securityLog.record(store, { type: 'password_changed', detail: 'password=Sup3rSecret token=abc123def456ghi789 mail me at ann@example.test beebo_session=xyz.123.abc' })
  const text = JSON.stringify(securityLog.list(store))
  for (const leak of ['Sup3rSecret', 'abc123def456ghi789', 'ann@example.test', 'xyz.123.abc']) assert.ok(!text.includes(leak), leak)
  securityLog.record(store, { type: 'password_changed', detail: 'x'.repeat(5000) })
  assert.ok(securityLog.list(store)[0].detail.length <= 200)
})

test('unknown event types are ignored; known ones carry a label and severity', () => {
  const store = fakeStore()
  assert.equal(securityLog.record(store, { type: 'made_up' }), null)
  assert.equal(securityLog.record(store, {}), null)
  securityLog.record(store, { type: 'two_factor_locked', userId: 'u1' })
  const [evt] = securityLog.list(store)
  assert.equal(evt.severity, 'alert')
  assert.match(evt.label, /locked/i)
  assert.equal(evt.userId, 'u1')
})

test('newest first, filterable, capped at 500', () => {
  const store = fakeStore()
  for (let i = 0; i < securityLog.MAX_EVENTS + 25; i++) securityLog.record(store, { type: i % 2 ? 'login_failed' : 'login_success', userId: i % 3 ? 'a' : 'b', ip: `10.1.${Math.floor(i / 250)}.${(i % 250) + 1}` })
  assert.equal(securityLog.list(store, { limit: 1000 }).length, securityLog.MAX_EVENTS)
  assert.equal(securityLog.list(store, { type: 'login_failed', limit: 10 }).every((e) => e.type === 'login_failed'), true)
  assert.equal(securityLog.list(store, { userId: 'b', limit: 10 }).every((e) => e.userId === 'b'), true)
  assert.equal(securityLog.list(store, { severity: 'warn', limit: 5 }).length, 5)
  const times = securityLog.list(store, { limit: 20 }).map((e) => e.time)
  assert.deepEqual(times, [...times].sort((a, b) => b - a))
})

test('a flood of events is not written to config.json one by one; flush() and clear() persist', () => {
  const store = fakeStore()
  for (let i = 0; i < 200; i++) securityLog.record(store, { type: 'login_failed', ip: `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}` })
  assert.equal(store.writes, 0, 'held in memory, flushed on a timer')
  assert.equal(securityLog.flush(store), true)
  assert.equal(store.writes, 1)
  assert.equal(store.data.securityEvents.length, 200)
  assert.equal(securityLog.flush(store), false, 'nothing new to write')
  securityLog.clear(store)
  assert.deepEqual(store.data.securityEvents, [])
  assert.deepEqual(securityLog.list(store), [])
})

test('a saved log is read back, and a damaged one is ignored, never thrown on', () => {
  const store = fakeStore({ securityEvents: [{ id: 'a', time: 5, type: 'login_success', severity: 'info' }, 'junk', null] })
  assert.equal(securityLog.list(store).length, 1)
  const broken = fakeStore({ securityEvents: 'not an array' })
  assert.deepEqual(securityLog.list(broken), [])
})

test('a flood of identical failures is one line with a count, so it cannot push real events out', () => {
  const store = fakeStore()
  securityLog.record(store, { type: 'password_changed', userId: 'u1' })
  for (let i = 0; i < 1000; i++) securityLog.record(store, { type: 'login_failed', username: 'ann', known: true, ip: '203.0.113.9' })
  const events = securityLog.list(store)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'login_failed')
  assert.equal(events[0].count, 1000)
  assert.ok(events.some((e) => e.type === 'password_changed'))
  // A different address is its own line.
  securityLog.record(store, { type: 'login_failed', username: 'ann', known: true, ip: '198.51.100.1' })
  assert.equal(securityLog.list(store).length, 3)
})
