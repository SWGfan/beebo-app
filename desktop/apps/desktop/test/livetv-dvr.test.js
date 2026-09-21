// Live TV DVR: tuner planning and conflicts, scheduling rules, series rules from the guide, file
// naming, keep-N cleanup (inside the Recordings folder only), persistence across a restart, and a real
// recording of the fake tuner. Run: node --test test/livetv-dvr.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const fake = require('./helpers/fakeHdhr')

const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const dvrLib = localRequire('./electron/liveTv/dvr')
const channelsLib = localRequire('./electron/liveTv/channels')
const { createTunerPool } = localRequire('./electron/liveTv/tunerPool')

const MIN = 60 * 1000
const HOUR = 60 * MIN

test('planTuners: same channel shares a tuner, different channels need their own, priority decides who loses', () => {
  const dev = () => [{ id: 'A', tunerCount: 2 }]
  const T = (id, channel, from, to, priority = 1) => ({ id, channel, from, to, priority })
  assert.deepEqual(dvrLib.planTuners([T('1', '2.1', 0, 10), T('2', '4.1', 5, 15)], dev).conflicts, [])
  assert.deepEqual(dvrLib.planTuners([T('1', '2.1', 0, 10), T('2', '2.1', 5, 15), T('3', '4.1', 5, 15)], dev).conflicts, [], 'same channel twice = one tuner')
  const three = dvrLib.planTuners([T('1', '2.1', 0, 10), T('2', '4.1', 0, 10), T('3', '9.1', 5, 8)], dev)
  assert.deepEqual(three.conflicts.map((c) => c.id), ['3'])
  assert.deepEqual(three.conflicts[0].blockedBy.sort(), ['1', '2'])
  assert.deepEqual(dvrLib.planTuners([T('1', '2.1', 0, 10), T('2', '4.1', 10, 20), T('3', '9.1', 20, 30)], dev).conflicts, [], 'back to back is fine')
  const prio = dvrLib.planTuners([T('late', '9.1', 5, 8, 2), T('a', '2.1', 0, 10, 1), T('b', '4.1', 0, 10, 1)], dev)
  assert.deepEqual(prio.conflicts.map((c) => c.id), ['late'], 'lower priority number wins the tuner')
  const two = [{ id: 'A', tunerCount: 1 }, { id: 'B', tunerCount: 1 }]
  const plan = dvrLib.planTuners([T('1', '2.1', 0, 10), T('2', '4.1', 0, 10)], () => two)
  assert.deepEqual(Object.values(plan.assignments).sort(), ['A', 'B'], 'two tuners in two boxes')
  assert.deepEqual(dvrLib.planTuners([T('1', 'x', 0, 10)], () => []).conflicts.map((c) => c.id), ['1'], 'no tuner can receive it')
  // A later short one that fits in a gap between long ones of the same device.
  assert.deepEqual(dvrLib.planTuners([T('1', '2.1', 0, 100), T('2', '4.1', 0, 40), T('3', '9.1', 50, 100)], dev).conflicts, [])
})

test('file names: Show/Season N/Show - SxxEyy - Title.ext, no path tricks, reserved names, date-based when the guide has no numbers', () => {
  const item = { title: 'Evening News', subTitle: 'Top: stories?', season: 3, episode: 5, start: Date.UTC(2026, 8, 21, 18), part: 1 }
  assert.equal(dvrLib.recordingRelPath(item, 'mkv'), path.join('Evening News', 'Season 3', 'Evening News - S03E05 - Top stories.mkv'))
  const evil = dvrLib.recordingRelPath({ ...item, title: '../../Windows\\System32:*?"<>|', subTitle: 'CON' }, 'ts')
  assert.ok(!evil.includes('..') && evil.split(path.sep).length === 3, evil)
  assert.equal(dvrLib.safeName('NUL'), 'Recording')
  assert.equal(dvrLib.safeName('   '), 'Recording')
  assert.equal(dvrLib.safeName('a'.repeat(300)).length, 90)
  const d = new Date(2026, 8, 21, 18, 5)
  const dated = dvrLib.recordingRelPath({ title: 'Local News', subTitle: '', season: null, episode: null, start: d.getTime(), part: 1 }, 'ts')
  assert.match(dated, /Local News[\\/]Season 26[\\/]Local News - S26E264 - 2026-09-21 1805\.ts$/)
  assert.match(dvrLib.recordingRelPath({ ...item, part: 2 }, 'ts'), /\(part 2\)\.ts$/)
  assert.equal(dvrLib.titleMatches({ title: 'The Show', match: 'exact' }, 'the show!'), true)
  assert.equal(dvrLib.titleMatches({ title: 'The Show', match: 'exact' }, 'The Show Returns'), false)
  assert.equal(dvrLib.titleMatches({ title: 'Show', match: 'contains' }, 'The Show Returns'), true)
  assert.equal(dvrLib.titleMatches({ title: 'ab', match: 'contains' }, 'abc'), false, 'too short to be a contains rule')
})

function harness(t, { tunerCount = 2, dvrOn = true, guideData = [], now, freeBytes } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-dvr-test-'))
  const rec = path.join(dir, 'Recordings')
  const clock = { t: now || Date.UTC(2026, 8, 21, 12, 0) }
  const config = channelsLib.normalizeConfig({
    enabled: true,
    devices: [{ id: '1A2B3C4D', ip: '192.168.1.10', apiPort: 80, streamPort: 5004, tunerCount }],
    lineups: { '1A2B3C4D': { channels: [{ guideNumber: '2.1', guideName: 'KTST' }, { guideNumber: '4.1', guideName: 'WNEWS' }, { guideNumber: '9.1', guideName: 'KIDS' }] } },
    settings: { dvrEnabled: dvrOn, recordingsDir: dvrOn ? rec : '', container: 'ts', padBeforeSec: 60, padAfterSec: 120 }
  })
  const chans = channelsLib.buildChannels(config).channels
  let programmes = guideData
  const guide = { upcoming: (from, to) => programmes.filter((p) => p.stop > from && p.start < to) }
  const pool = { acquire: async () => { throw new Error('not used') } }
  const make = () => dvrLib.createDvr({ dir, getConfig: () => config, getChannels: () => chans, guide, pool, ffmpegPath: () => null, now: () => clock.t, freeBytes: () => Infinity, tickMs: 1e9, timers: { setInterval: () => 0, clearInterval() {} }, ...(freeBytes ? { freeBytes } : {}) })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, rec, clock, config, chans, make, dvr: make(), setGuide: (p) => { programmes = p } }
}
const user = { id: 'owner' }
const prog = (o) => ({ channel: '2.1', title: 'Show', subTitle: '', season: null, episode: null, isNew: false, categories: [], ...o })

test('schedule: needs DVR turned on and a folder, a known channel, sensible times; padding applied; duplicates refused', () => {
  const off = harness({ after() {} }, { dvrOn: false })
  assert.equal(off.dvr.schedule({ channel: '2.1', title: 'X', start: off.clock.t + HOUR, end: off.clock.t + 2 * HOUR }, user).error, 'dvr_off')
  const h = harness({ after() {} })
  const at = h.clock.t
  const ok = h.dvr.schedule({ channel: '2.1', title: 'Evening News', start: at + HOUR, end: at + 2 * HOUR }, user)
  assert.equal(ok.ok, true)
  assert.equal(ok.item.recordFrom, at + HOUR - MIN, 'one minute early')
  assert.equal(ok.item.recordTo, at + 2 * HOUR + 2 * MIN, 'two minutes late')
  assert.equal(h.dvr.schedule({ channel: '2.1', title: 'Evening News', start: at + HOUR, end: at + 2 * HOUR }, user).error, 'already_scheduled')
  assert.equal(h.dvr.schedule({ channel: 'nope', title: 'X', start: at + HOUR, end: at + 2 * HOUR }, user).error, 'unknown_channel')
  assert.equal(h.dvr.schedule({ channel: '2.1', title: 'X', start: at - 2 * HOUR, end: at - HOUR }, user).error, 'in_past')
  assert.equal(h.dvr.schedule({ channel: '2.1', title: 'X', start: at + HOUR, end: at + HOUR + 10 }, user).error, 'bad_length')
  assert.equal(h.dvr.schedule({ channel: '2.1', title: 'X', start: at + HOUR, end: at + 20 * HOUR }, user).error, 'bad_length')
  assert.equal(h.dvr.schedule({ channel: '2.1', title: '  ', start: at + HOUR, end: at + 2 * HOUR }, user).error, 'no_title')
  assert.equal(h.dvr.schedule({ channel: '2.1', title: 'X', start: 'soon', end: 'later' }, user).error, 'bad_time')
  assert.equal(h.dvr.schedule({ channel: '2.1', title: 'X', start: at + 60 * 24 * HOUR, end: at + 60 * 24 * HOUR + HOUR }, user).error, 'too_far')
  const nowShow = h.dvr.schedule({ channel: '4.1', title: 'In progress', start: at - HOUR, end: at + HOUR }, user)
  assert.equal(nowShow.item.start, at, 'a programme already on is recorded from now')
})

test('conflicts are found when scheduling, with a plain message naming what is in the way; the owner may force it', () => {
  const h = harness({ after() {} }, { tunerCount: 2 })
  const at = h.clock.t + HOUR
  assert.equal(h.dvr.schedule({ channel: '2.1', title: 'Alpha', start: at, end: at + HOUR }, user).ok, true)
  assert.equal(h.dvr.schedule({ channel: '4.1', title: 'Beta', start: at, end: at + HOUR }, user).ok, true)
  const c = h.dvr.schedule({ channel: '9.1', title: 'Gamma', start: at + 10 * MIN, end: at + 30 * MIN }, user)
  assert.equal(c.ok, false)
  assert.equal(c.error, 'conflict')
  assert.match(c.message, /not enough tuners/)
  assert.match(c.message, /"Alpha"/)
  assert.match(c.message, /"Beta"/)
  assert.equal(c.blockedBy.length, 2)
  const later = h.dvr.schedule({ channel: '9.1', title: 'Gamma', start: at + 2 * HOUR, end: at + 3 * HOUR }, user)
  assert.equal(later.ok, true, 'a different time is fine')
  const forced = h.dvr.schedule({ channel: '9.1', title: 'Gamma2', start: at + 10 * MIN, end: at + 30 * MIN }, user, { force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.conflict, true)
  const list = h.dvr.list()
  assert.equal(list.conflicts.length, 1)
  assert.equal(list.items.find((i) => i.title === 'Gamma2').conflict, true)
})

test('series rules: schedule only matching titles from the guide, new episodes only, no duplicates, skip what does not fit, cancel with the rule', () => {
  const h = harness({ after() {} }, { tunerCount: 1 })
  const at = h.clock.t
  h.setGuide([
    prog({ title: 'The Show', start: at + HOUR, stop: at + 2 * HOUR, isNew: true, season: 2, episode: 3 }),
    prog({ title: 'The Show', start: at + 25 * HOUR, stop: at + 26 * HOUR, isNew: false, season: 1, episode: 1 }),
    prog({ title: 'The Show', start: at + 49 * HOUR, stop: at + 50 * HOUR, isNew: true, season: 2, episode: 4 }),
    prog({ title: 'Another Thing', start: at + 3 * HOUR, stop: at + 4 * HOUR }),
    prog({ channel: '4.1', title: 'The Show', start: at + 49 * HOUR, stop: at + 50 * HOUR, isNew: true, season: 2, episode: 9 })
  ])
  const r = h.dvr.addRule({ title: 'The Show', onlyNew: true }, user)
  assert.equal(r.ok, true)
  assert.equal(r.scheduled, 2, 'the two new airings; the rerun is skipped; the second channel’s airing clashes on the single tuner')
  const items = h.dvr.list().items
  assert.deepEqual(items.map((i) => i.title), ['The Show', 'The Show'])
  assert.ok(items.every((i) => i.kind === 'rule'))
  assert.equal(h.dvr.list().rules[0].lastSkipped, 1, 'the clash is reported on the rule')
  assert.equal(h.dvr.applyRules().added, 0, 'running the rules again adds nothing')
  assert.equal(h.dvr.addRule({ title: 'The Show' }, user).error, 'duplicate')
  assert.equal(h.dvr.addRule({ title: '' }, user).error, 'no_title')
  assert.equal(h.dvr.addRule({ title: 'X', channel: 'nope' }, user).error, 'unknown_channel')
  const removed = h.dvr.removeRule(h.dvr.list().rules[0].id)
  assert.equal(removed.ok, true)
  assert.equal(h.dvr.list().items.length, 0, 'upcoming recordings of the rule are cancelled with it')
  // Nothing at all is recorded without a rule or an explicit schedule.
  h.dvr.applyRules()
  assert.equal(h.dvr.list().items.length, 0)
})

test('persistence: schedules and rules survive a restart; a corrupt file is quarantined, never crashes', (t) => {
  const h = harness(t)
  const at = h.clock.t
  h.dvr.schedule({ channel: '2.1', title: 'Persisted', start: at + HOUR, end: at + 2 * HOUR }, user)
  h.dvr.addRule({ title: 'A Rule' }, user)
  const again = h.make()
  assert.deepEqual(again.list().items.map((i) => i.title), ['Persisted'])
  assert.deepEqual(again.list().rules.map((r) => r.title), ['A Rule'])
  const file = path.join(h.dir, 'dvr.json')
  assert.ok(fs.existsSync(file))
  fs.writeFileSync(file, '{ "items": [ {"broken')
  const third = h.make()
  assert.ok(Array.isArray(third.list().items))
  assert.ok(fs.readdirSync(h.dir).some((f) => f.startsWith('dvr.json.corrupt-')), 'the damaged file is kept aside')
  fs.writeFileSync(file, JSON.stringify({ items: [null, 5, { channel: '2.1', start: 1, end: 0 }, { channel: '../..', start: 1, end: 5 }, { channel: '2.1', title: 'ok', start: 1, end: 5, status: 'weird' }], rules: [{ title: '' }, 'x'] }))
  const fourth = h.make()
  assert.deepEqual(fourth.list().items.map((i) => [i.title, i.status]), [['ok', 'scheduled']])
  assert.deepEqual(fourth.list().rules, [])
})

test('keep-latest and delete only ever remove files inside the Recordings folder', (t) => {
  const h = harness(t)
  h.dvr.addRule({ title: 'Keeper', keepN: 2 }, user)
  const rule = h.dvr.list().rules[0]
  const outside = path.join(h.dir, 'precious.mkv')
  fs.mkdirSync(path.join(h.rec, 'Keeper', 'Season 1'), { recursive: true })
  const mk = (n, start, file) => { fs.writeFileSync(file, 'x'.repeat(10)); return { id: 'r' + String(n).padStart(12, '0'), kind: 'rule', ruleId: rule.id, channel: '2.1', channelName: 'KTST', title: 'Keeper', start, end: start + HOUR, status: 'done', file, padBeforeSec: 60, padAfterSec: 60, container: 'ts', userId: 'owner', createdAt: 1, identity: 'k' + n } }
  const files = [1, 2, 3, 4].map((n) => path.join(h.rec, 'Keeper', 'Season 1', `Keeper - S01E0${n}.ts`))
  const items = [mk(1, 1000 * HOUR, files[0]), mk(2, 2000 * HOUR, files[1]), mk(3, 3000 * HOUR, files[2]), mk(4, 4000 * HOUR, outside)]
  fs.writeFileSync(outside, 'keep me')
  h.dvr.state.update((s) => { s.items.push(...items.map((i) => ({ ...i, part: 1, subTitle: '', season: null, episode: null, size: 10, startedAt: 0, endedAt: 0, error: '' }))) })
  const removed = h.dvr.cleanup()
  assert.equal(removed, 2, 'the 2 oldest of 4 go')
  assert.equal(fs.existsSync(files[0]), false)
  assert.equal(fs.existsSync(files[1]), false)
  assert.equal(fs.existsSync(files[2]), true)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me', 'the newest is kept, and it was outside the folder anyway')
  // Deleting an entry whose file path was tampered to point outside the folder never touches that file.
  h.dvr.state.update((s) => { s.items.push({ ...items[3], id: 'r000000000099', file: outside, start: 1, status: 'done', ruleId: null, part: 1, subTitle: '', season: null, episode: null, size: 1, startedAt: 0, endedAt: 0, error: '' }) })
  const del = h.dvr.deleteRecording('r000000000099')
  assert.equal(del.ok, false)
  assert.equal(fs.existsSync(outside), true)
  assert.equal(h.dvr.deleteRecording('r000000000003').ok, true)
  assert.equal(fs.existsSync(files[2]), false)
  assert.equal(h.dvr.deleteRecording('nope').error, 'not_found')
  assert.equal(fs.existsSync(path.join(h.rec, 'Keeper')), false, 'emptied folders are tidied up')
})

test('cancel removes a scheduled recording; missed recordings (app was off) are marked, not forgotten', (t) => {
  const h = harness(t)
  const at = h.clock.t
  const a = h.dvr.schedule({ channel: '2.1', title: 'A', start: at + HOUR, end: at + 2 * HOUR }, user).item
  assert.equal(h.dvr.cancel(a.id).ok, true)
  assert.equal(h.dvr.list().items.length, 0)
  assert.equal(h.dvr.cancel(a.id).error, 'not_found')
  const b = h.dvr.schedule({ channel: '2.1', title: 'B', start: at + HOUR, end: at + 2 * HOUR }, user).item
  h.clock.t = at + 5 * HOUR
  h.dvr.tick()
  const item = h.dvr.list().items.find((i) => i.id === b.id)
  assert.equal(item.status, 'missed')
  assert.match(item.error, /not running/)
})

// --------------------------------------------------------- a real recording
test('records the fake tuner to a .ts file inside the Recordings folder, with padding, then finishes and frees the tuner', { timeout: 60000 }, async (t) => {
  const dev = await fake.createFakeHdhr({ real: false, tunerCount: 2 })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-dvr-rec-'))
  t.after(async () => { await dev.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const rec = path.join(dir, 'Recordings')
  const config = channelsLib.normalizeConfig({
    enabled: true, devices: [dev.device()],
    lineups: { [dev.deviceId]: { channels: [{ guideNumber: '2.1', guideName: 'KTST' }, { guideNumber: '4.1', guideName: 'WNEWS' }] } },
    settings: { dvrEnabled: true, recordingsDir: rec, container: 'ts', padBeforeSec: 0, padAfterSec: 0 }
  })
  config.devices[0].allowNonLan = true
  const chans = channelsLib.buildChannels(config).channels
  const pool = createTunerPool({ getDevices: () => config.devices })
  t.after(() => pool.closeAll())
  const dvr = dvrLib.createDvr({ dir, getConfig: () => config, getChannels: () => chans, guide: { upcoming: () => [] }, pool, ffmpegPath: () => null, tickMs: 200 })
  t.after(() => dvr.stop())
  const start = Date.now()
  const r = dvr.schedule({ channel: '2.1', title: 'Real Recording', start, end: start + 6000, padBeforeSec: 0, padAfterSec: 0 }, user)
  assert.equal(r.ok, false, 'shorter than a minute is refused')
  const ok = dvr.schedule({ channel: '2.1', title: 'Real Recording', start: start + 1000, end: start + 61000, padBeforeSec: 0, padAfterSec: 0 }, user)
  assert.equal(ok.ok, true)
  dvr.state.update((s) => { const i = s.items[0]; i.start = Date.now(); i.end = Date.now() + 4000; i.padBeforeSec = 0; i.padAfterSec = 0 })
  dvr.start()
  let item
  for (let i = 0; i < 100; i++) { await new Promise((res) => setTimeout(res, 100)); item = dvr.list().items[0]; if (item.status === 'recording') break }
  assert.equal(item.status, 'recording')
  assert.equal(dev.activeStreams(), 1, 'the recording holds a tuner')
  const live = await pool.acquire({ channel: chans[0], purpose: 'live', label: 'watching too' })
  assert.equal(dev.activeStreams(), 1, 'a viewer of the same channel shares the recording’s tuner')
  live.release()
  for (let i = 0; i < 150; i++) { await new Promise((res) => setTimeout(res, 100)); item = dvr.list().items[0]; if (item.status !== 'recording') break }
  assert.equal(item.status, 'done', item.error)
  assert.ok(item.size >= dvrLib.MIN_USEFUL_BYTES, 'bytes were written: ' + item.size)
  const file = dvr.state.get().items[0].file
  assert.ok(file.startsWith(rec + path.sep), file)
  assert.match(path.basename(file), /^Real Recording - S\d\dE\d+ - .*\.ts$/)
  assert.equal(fs.readFileSync(file)[0], 0x47, 'MPEG-TS on disk')
  await new Promise((res) => setTimeout(res, 300))
  assert.equal(dev.activeStreams(), 0, 'tuner released')
  assert.equal(dvr.list().items[0].fileName, path.basename(file))
})

test('a tuner that is busy at start time is retried and then reported, not silently lost', { timeout: 30000 }, async (t) => {
  const dev = await fake.createFakeHdhr({ real: false, tunerCount: 1 })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-dvr-busy-'))
  t.after(async () => { await dev.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const config = channelsLib.normalizeConfig({
    enabled: true, devices: [dev.device()], lineups: { [dev.deviceId]: { channels: [{ guideNumber: '2.1', guideName: 'A' }, { guideNumber: '4.1', guideName: 'B' }] } },
    settings: { dvrEnabled: true, recordingsDir: path.join(dir, 'R'), container: 'ts', padBeforeSec: 0, padAfterSec: 0 }
  })
  const chans = channelsLib.buildChannels(config).channels
  const pool = createTunerPool({ getDevices: () => config.devices })
  t.after(() => pool.closeAll())
  const dvr = dvrLib.createDvr({ dir, getConfig: () => config, getChannels: () => chans, guide: { upcoming: () => [] }, pool, ffmpegPath: () => null, tickMs: 100 })
  t.after(() => dvr.stop())
  const other = await pool.acquire({ channel: chans[1], purpose: 'record', label: 'Existing recording' })
  const s = Date.now()
  dvr.schedule({ channel: '2.1', title: 'Blocked', start: s + 1000, end: s + 61000, padBeforeSec: 0, padAfterSec: 0 }, user, { force: true })
  dvr.state.update((st) => { const i = st.items[0]; i.start = Date.now(); i.end = Date.now() + 1500 })
  dvr.start()
  let item
  for (let i = 0; i < 80; i++) { await new Promise((res) => setTimeout(res, 100)); item = dvr.list().items[0]; if (item.status === 'failed') break }
  assert.equal(item.status, 'failed')
  assert.match(item.error, /busy/)
  other.release()
})
