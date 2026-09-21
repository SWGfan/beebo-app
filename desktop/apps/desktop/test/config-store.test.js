'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { openStore, backupConfig, listBackups, describeRecovery, localDay, inspectConfig } = require('../electron/configStore')

function userData() { return fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-config-')) }
const DAY = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime()

// Behaves like electron-store: reading a config that does not parse throws at construction.
class FakeStore {
  constructor() {
    this.path = path.join(FakeStore.dir, 'config.json')
    this.data = fs.existsSync(this.path) ? JSON.parse(fs.readFileSync(this.path, 'utf8')) : {}
  }
  get(k) { return this.data[k] }
}
function open(dir, extra) { FakeStore.dir = dir; return openStore(Object.assign({ Store: FakeStore, userDataDir: dir }, extra)) }
const write = (dir, text) => fs.writeFileSync(path.join(dir, 'config.json'), text)

test('a healthy config opens untouched and is backed up once per day', () => {
  const dir = userData()
  write(dir, JSON.stringify({ moviesDir: 'D:\\Movies' }))
  const day1 = DAY(2026, 9, 21)
  const a = open(dir, { now: day1 })
  assert.equal(a.recovery, null)
  assert.equal(a.store.get('moviesDir'), 'D:\\Movies')
  assert.deepEqual(listBackups(a.backupsDir).map((b) => b.day), ['2026-09-21'])
  write(dir, JSON.stringify({ moviesDir: 'E:\\Later' }))
  open(dir, { now: day1 + 3600 * 1000 })
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.backupsDir, 'config-2026-09-21.json'), 'utf8')).moviesDir, 'D:\\Movies', 'second start on the same day does not replace the copy')
})

test('clean quit refreshes today\'s copy so the newest state of the day is what is kept', () => {
  const dir = userData()
  write(dir, JSON.stringify({ v: 1 }))
  const s = open(dir, { now: DAY(2026, 9, 21) })
  write(dir, JSON.stringify({ v: 2 }))
  assert.equal(s.backup({ refresh: true }).ok, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.backupsDir, 'config-' + localDay(Date.now()) + '.json'), 'utf8')).v, 2)
})

test('only the newest 7 daily copies are kept', () => {
  const dir = userData()
  write(dir, JSON.stringify({ v: 1 }))
  let s
  for (let d = 1; d <= 12; d++) s = open(dir, { now: DAY(2026, 9, d) })
  const days = listBackups(s.backupsDir).map((b) => b.day)
  assert.equal(days.length, 7)
  assert.equal(days[0], '2026-09-12')
  assert.equal(days[6], '2026-09-06')
})

test('corruption matrix: a damaged config is set aside, the newest good copy is restored, and the app can start', () => {
  const bad = {
    truncated: '{"moviesDir": "D:\\\\Movies", "authUsers": [{"id": "a", "na',
    empty: '',
    garbage: Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x9c, 0x00]),
    notAnObject: '[1,2,3]',
    justNull: 'null',
    text: 'hello'
  }
  for (const [name, bytes] of Object.entries(bad)) {
    const dir = userData()
    write(dir, JSON.stringify({ moviesDir: 'good-yesterday' }))
    open(dir, { now: DAY(2026, 9, 20) })
    fs.writeFileSync(path.join(dir, 'config.json'), bytes)
    const s = open(dir, { now: DAY(2026, 9, 21) })
    assert.equal(s.recovery.kind, 'restored', name)
    assert.equal(s.recovery.backupDay, '2026-09-20', name)
    assert.equal(s.store.get('moviesDir'), 'good-yesterday', name)
    assert.deepEqual(fs.readFileSync(s.recovery.quarantinedTo), Buffer.from(bytes), name + ': the damaged file is kept intact')
    assert.equal(inspectConfig(path.join(dir, 'config.json')).state, 'ok', name)
  }
})

test('damaged config and no backup: starts fresh, keeps the damaged file, never writes {} over it', () => {
  const dir = userData()
  write(dir, '{"half')
  const s = open(dir, { now: DAY(2026, 9, 21) })
  assert.equal(s.recovery.kind, 'reset')
  assert.equal(fs.readFileSync(s.recovery.quarantinedTo, 'utf8'), '{"half')
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false)
  assert.equal(listBackups(s.backupsDir).length, 0, 'a fresh empty config is not backed up over anything')
})

test('the newest backup is itself damaged: falls back to the next one', () => {
  const dir = userData()
  const backups = path.join(dir, 'config-backups')
  fs.mkdirSync(backups)
  fs.writeFileSync(path.join(backups, 'config-2026-09-19.json'), JSON.stringify({ from: 'the 19th' }))
  fs.writeFileSync(path.join(backups, 'config-2026-09-20.json'), '{"tor')
  write(dir, 'garbage')
  const s = open(dir, { now: DAY(2026, 9, 21) })
  assert.equal(s.recovery.backupDay, '2026-09-19')
  assert.equal(s.store.get('from'), 'the 19th')
})

test('a config saved with a byte-order mark (Notepad "UTF-8 with BOM") is fixed in place, not discarded', () => {
  const dir = userData()
  class StrictStore extends FakeStore {
    constructor() { super(); if (fs.readFileSync(this.path, 'utf8').charCodeAt(0) === 0xfeff) throw new SyntaxError('Unexpected token') }
  }
  FakeStore.dir = dir
  write(dir, '﻿' + JSON.stringify({ moviesDir: 'kept', authUsers: [{ id: 'a' }] }))
  const s = openStore({ Store: StrictStore, userDataDir: dir, now: DAY(2026, 9, 21) })
  assert.equal(s.recovery, null, 'no recovery, nothing lost')
  assert.equal(s.store.get('moviesDir'), 'kept')
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').charCodeAt(0), 0x7b)
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.corrupt-')).length, 0)
})

test('missing config is a normal first run, not a recovery', () => {
  const dir = userData()
  const s = open(dir, { now: DAY(2026, 9, 21) })
  assert.equal(s.recovery, null)
  assert.equal(listBackups(s.backupsDir).length, 0)
})

test('a config that cannot be read (permission error) is left alone and the error surfaces', () => {
  const dir = userData()
  write(dir, JSON.stringify({ keep: 1 }))
  const real = fs.readFileSync
  fs.readFileSync = function (p, ...rest) {
    if (String(p).endsWith('config.json')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e }
    return real.call(fs, p, ...rest)
  }
  try {
    assert.throws(() => open(dir, { now: DAY(2026, 9, 21) }), /EACCES/)
  } finally { fs.readFileSync = real }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json'], 'nothing was renamed or copied')
})

test('the store refusing a file that looked fine gets one recovery attempt', () => {
  const dir = userData()
  write(dir, JSON.stringify({ moviesDir: 'ok' }))
  open(dir, { now: DAY(2026, 9, 20) })
  let calls = 0
  class Flaky extends FakeStore {
    constructor() { if (calls++ === 0) throw new SyntaxError('Unexpected end of JSON input'); super() }
  }
  FakeStore.dir = dir
  const s = openStore({ Store: Flaky, userDataDir: dir, now: DAY(2026, 9, 21) })
  assert.equal(s.recovery.kind, 'restored')
  assert.equal(s.store.get('moviesDir'), 'ok')
})

test('a store that keeps failing after recovery throws (fatal startup handles it)', () => {
  const dir = userData()
  write(dir, JSON.stringify({ a: 1 }))
  class Broken { constructor() { throw new Error('nope') } }
  assert.throws(() => openStore({ Store: Broken, userDataDir: dir }), /nope/)
})

test('backup never copies a config that does not parse', () => {
  const dir = userData()
  write(dir, '{"broken')
  const r = backupConfig({ file: path.join(dir, 'config.json'), backupsDir: path.join(dir, 'config-backups'), now: DAY(2026, 9, 21) })
  assert.equal(r.ok, false)
  assert.equal(fs.existsSync(path.join(dir, 'config-backups')), false)
})

test('a leftover .tmp from a crashed backup does not confuse listing or restore', () => {
  const dir = userData()
  const backups = path.join(dir, 'config-backups')
  fs.mkdirSync(backups)
  fs.writeFileSync(path.join(backups, 'config-2026-09-20.json'), JSON.stringify({ ok: 1 }))
  fs.writeFileSync(path.join(backups, 'config-2026-09-21.json.tmp'), '{"half')
  assert.deepEqual(listBackups(backups).map((b) => b.name), ['config-2026-09-20.json'])
})

test('the message for the person is plain words and says what was kept', () => {
  const restored = describeRecovery({ kind: 'restored', backupDay: '2026-09-20', quarantinedTo: 'C:\\x\\config.json.corrupt-1' })
  assert.match(restored.detail, /2026-09-20/)
  assert.match(restored.detail, /config\.json\.corrupt-1/)
  assert.doesNotMatch(JSON.stringify(restored), /SyntaxError|Unexpected token|stack/)
  const reset = describeRecovery({ kind: 'reset', quarantinedTo: 'C:\\x\\config.json.corrupt-1' })
  assert.match(reset.detail, /your videos and photos were not touched/)
  assert.equal(describeRecovery(null), null)
})
