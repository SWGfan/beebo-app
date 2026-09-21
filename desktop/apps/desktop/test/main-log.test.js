'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMainLog, lastProblems } = require('../electron/mainLog')

function tmpDir() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-mainlog-')), 'logs') }
const allLogText = (dir) => fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n')

test('lines are redacted before they reach the disk, on every console method', () => {
  const dir = tmpDir()
  const log = createMainLog({ dir })
  const fake = { log() {}, info() {}, warn() {}, error() {}, debug() {} }
  const uninstall = log.install(fake)
  const secret = 'Zx9-Qm2_LkP7vT4nR8sW1yU6cE3bH5jA0dGfIoXhNqM'
  fake.log('[stream]', 'GET /v?mt=' + secret + ' 200')
  fake.warn('Authorization: Bearer ' + secret)
  fake.error(new Error('failed with password=hunter2 and token=' + secret))
  fake.info({ tmdbApiKey: 'a1b2c3d4'.repeat(4), ok: true })
  fake.debug('viewer 203.0.113.9 signed in as someone@example.com')
  log.flushSync()
  uninstall()
  const text = allLogText(dir)
  for (const s of [secret, 'hunter2', 'a1b2c3d4a1b2', '203.0.113.9', 'someone@example.com']) assert.ok(!text.includes(s), 'leaked ' + s)
  assert.match(text, /INFO \[stream\] GET \/v\?mt=\[redacted\] 200/)
  assert.match(text, /WARN Authorization: \[redacted\]/)
  assert.match(text, /ERROR Error: failed with password=\[redacted\]/)
})

test('the original console still gets every call, and uninstall restores it', () => {
  const seen = []
  const fake = { log: (...a) => seen.push(['log', ...a]), warn: (...a) => seen.push(['warn', ...a]), error() {}, info() {}, debug() {} }
  const origLog = fake.log
  const log = createMainLog({ dir: tmpDir() })
  const uninstall = log.install(fake)
  fake.log('a', 1)
  fake.warn('b')
  assert.deepEqual(seen, [['log', 'a', 1], ['warn', 'b']])
  uninstall()
  assert.equal(fake.log, origLog)
})

test('a throwing console (closed stdout pipe) does not break the caller', () => {
  const fake = { log() { throw new Error('EPIPE') }, info() {}, warn() {}, error() {}, debug() {} }
  const log = createMainLog({ dir: tmpDir() })
  log.install(fake)
  assert.doesNotThrow(() => fake.log('still works'))
  log.flushSync()
  assert.match(fs.readFileSync(log.file, 'utf8'), /still works/)
})

test('rotates at the size limit and keeps only the configured number of files', () => {
  const dir = tmpDir()
  const log = createMainLog({ dir, maxBytes: 2000, keep: 3 })
  for (let i = 0; i < 400; i++) { log.write('INFO', 'line number ' + i + ' ' + 'x'.repeat(40)); if (i % 10 === 0) log.flushSync() }
  log.flushSync()
  const names = fs.readdirSync(dir).sort()
  assert.deepEqual(names, ['main.1.log', 'main.2.log', 'main.3.log', 'main.log'])
  for (const n of names) assert.ok(fs.statSync(path.join(dir, n)).size <= 2000 + 700, n + ' stays near the limit')
  const text = allLogText(dir)
  assert.match(text, /line number 399 /, 'newest lines are kept')
  assert.doesNotMatch(text, /line number 0 /, 'oldest lines are gone')
})

test('a burst faster than the disk drops the oldest buffered lines and says so', () => {
  const dir = tmpDir()
  const log = createMainLog({ dir, maxBuffered: 4000 })
  for (let i = 0; i < 500; i++) log.write('INFO', 'burst ' + i + ' ' + 'y'.repeat(30))
  log.flushSync()
  const text = fs.readFileSync(log.file, 'utf8')
  assert.match(text, /log line\(s\) were dropped/)
  assert.match(text, /burst 499 /)
})

test('an ERROR line is flushed at once (a crash right after it must not lose it)', () => {
  const dir = tmpDir()
  const log = createMainLog({ dir, flushMs: 60000 })
  log.write('ERROR', 'boom')
  assert.match(fs.readFileSync(log.file, 'utf8'), /ERROR boom/)
})

test('an unwritable folder never throws', () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-mainlog-')), 'file')
  fs.writeFileSync(blocker, 'x')
  const log = createMainLog({ dir: path.join(blocker, 'logs') })
  assert.doesNotThrow(() => { log.write('ERROR', 'nowhere to go'); log.flushSync() })
})

test('readTail returns the newest text across a rotation, and lastProblems picks WARN/ERROR entries with their stack', () => {
  const dir = tmpDir()
  const log = createMainLog({ dir, maxBytes: 1500, keep: 2 })
  for (let i = 0; i < 60; i++) log.write('INFO', 'chatter ' + i + ' ' + 'z'.repeat(30))
  log.write('WARN', 'disk is nearly full')
  log.write('ERROR', 'Error: boom\n    at a (x.js:1:1)\n    at b (y.js:2:2)')
  log.write('INFO', 'after')
  const tail = log.readTail(8000)
  const problems = lastProblems(tail, 5)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /WARN disk is nearly full/)
  assert.match(problems[1], /ERROR Error: boom\n {4}at a \(x\.js:1:1\)\n {4}at b/)
})
