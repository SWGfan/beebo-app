'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createLoginItem, createAwakeKeeper, createResumeRecovery, SLEEP_NOTE, POWER_SETTINGS_URI } = require('../electron/alwaysOn')

function memStore(initial) {
  const d = Object.assign({}, initial)
  return { get: (k) => d[k], set: (k, v) => { d[k] = v }, data: d }
}
function fakeApp() {
  const calls = []
  let will = false
  return {
    calls,
    setLoginItemSettings(s) { calls.push(s); will = !!s.openAtLogin },
    getLoginItemSettings() { return { openAtLogin: will, executableWillLaunchAtLogin: will } },
    forceWindowsDisabled() { will = false }
  }
}

// ---- start at login ---------------------------------------------------------
test('login item: not supported in dev builds or on Linux, and never touches the system there (macOS: test/mac-platform.test.js)', () => {
  for (const cfg of [{ isPackaged: false, platform: 'win32' }, { isPackaged: false, platform: 'darwin' }, { isPackaged: true, platform: 'linux' }]) {
    const app = fakeApp()
    const store = memStore({})
    const li = createLoginItem(Object.assign({ app, store, hasSignedIn: () => true }, cfg))
    li.sync(); li.onSignedIn(); li.set(true)
    assert.equal(app.calls.length, 0)
    assert.equal(li.state().supported, false)
    assert.equal(li.state().enabled, false)
  }
})

test('login item: default ON after the first successful sign-in, starting hidden, and only once', () => {
  const app = fakeApp()
  const store = memStore({})
  const li = createLoginItem({ app, store, isPackaged: true, platform: 'win32', execPath: 'C:\\Beebo\\Beebo.exe' })
  li.sync()
  assert.equal(app.calls.length, 0, 'not signed in yet: nothing is registered')
  li.onSignedIn()
  assert.deepEqual(app.calls, [{ openAtLogin: true, path: 'C:\\Beebo\\Beebo.exe', args: ['--hidden'] }])
  assert.equal(store.get('startAtLogin'), true)
  assert.equal(li.state().enabled, true)
  li.onSignedIn()
  assert.equal(app.calls.length, 1, 'a later sign-in does not re-apply')
})

test('login item: an explicit OFF survives later sign-ins and restarts', () => {
  const app = fakeApp()
  const store = memStore({})
  const li = createLoginItem({ app, store, isPackaged: true, platform: 'win32', hasSignedIn: () => true })
  li.set(false)
  li.onSignedIn()
  li.sync()
  assert.equal(store.get('startAtLogin'), false)
  assert.ok(app.calls.every((c) => c.openAtLogin === false))
  assert.equal(li.state().enabled, false)
})

test('login item: an install that is already signed in but never chose gets the default at startup', () => {
  const app = fakeApp()
  const store = memStore({})
  const li = createLoginItem({ app, store, isPackaged: true, platform: 'win32', hasSignedIn: () => true })
  li.sync()
  assert.equal(store.get('startAtLogin'), true)
  assert.equal(app.calls[0].openAtLogin, true)
})

test('login item: re-applies the saved choice at every start (the install path can change on update)', () => {
  const app = fakeApp()
  const li = createLoginItem({ app, store: memStore({ startAtLogin: true }), isPackaged: true, platform: 'win32', execPath: 'C:\\new\\Beebo.exe' })
  li.sync()
  assert.deepEqual(app.calls, [{ openAtLogin: true, path: 'C:\\new\\Beebo.exe', args: ['--hidden'] }])
})

test('login item: says so when Windows has switched it off behind our back', () => {
  const app = fakeApp()
  const li = createLoginItem({ app, store: memStore({ startAtLogin: true }), isPackaged: true, platform: 'win32' })
  li.sync()
  app.forceWindowsDisabled()
  const s = li.state()
  assert.equal(s.enabled, true)
  assert.equal(s.blockedByWindows, true)
})

test('login item: a failing OS call is reported, not thrown', () => {
  const logs = []
  const app = { setLoginItemSettings() { throw new Error('registry locked') }, getLoginItemSettings: () => ({ openAtLogin: false }) }
  const li = createLoginItem({ app, store: memStore({}), isPackaged: true, platform: 'win32', log: (m) => logs.push(m) })
  assert.doesNotThrow(() => li.set(true))
  assert.match(logs.join(' '), /registry locked/)
})

// ---- stay awake only while needed ---------------------------------------------
function keeperHarness(sources) {
  let t = 1_000_000
  const blocker = { started: [], stopped: [], start(kind) { this.started.push(kind); return 41 + this.started.length }, stop(id) { this.stopped.push(id) } }
  const keeper = createAwakeKeeper({ powerSaveBlocker: blocker, sources, now: () => t, graceMs: 60000, setIntervalFn: () => ({ unref() {} }), clearIntervalFn() {} })
  return { keeper, blocker, advance: (ms) => { t += ms } }
}

test('awake keeper: idle means no wake lock at all', () => {
  const h = keeperHarness({ streams: () => false, downloads: () => false })
  h.keeper.evaluate(); h.advance(600000); h.keeper.evaluate()
  assert.deepEqual(h.blocker.started, [])
  assert.equal(h.keeper.status().holding, false)
})

test('awake keeper: uses prevent-app-suspension (never prevent-display-sleep), starts once, releases after the grace', () => {
  const on = { streams: false, conversion: false }
  const h = keeperHarness({ streams: () => on.streams, conversion: () => on.conversion })
  on.streams = true
  h.keeper.evaluate(); h.keeper.evaluate(); h.keeper.evaluate()
  assert.deepEqual(h.blocker.started, ['prevent-app-suspension'])
  assert.deepEqual(h.keeper.status().reasons, ['streams'])
  on.streams = false
  h.advance(30000); h.keeper.evaluate()
  assert.equal(h.keeper.status().holding, true, 'still inside the grace period')
  h.advance(31000); h.keeper.evaluate()
  assert.equal(h.keeper.status().holding, false)
  assert.equal(h.blocker.stopped.length, 1)
  on.conversion = true
  h.keeper.evaluate()
  assert.equal(h.blocker.started.length, 2)
  assert.deepEqual(h.keeper.status().reasons, ['conversion'])
})

test('awake keeper: several reasons share one lock; a throwing source is not a reason', () => {
  const h = keeperHarness({ a: () => true, b: () => true, broken: () => { throw new Error('gone') } })
  h.keeper.evaluate()
  assert.equal(h.blocker.started.length, 1)
  assert.deepEqual(h.keeper.status().reasons, ['a', 'b'])
})

test('awake keeper: stop() releases the lock immediately (quitting)', () => {
  const h = keeperHarness({ a: () => true })
  h.keeper.start()
  assert.equal(h.keeper.status().holding, true)
  h.keeper.stop()
  assert.equal(h.keeper.status().holding, false)
  assert.equal(h.blocker.stopped.length, 1)
})

test('awake keeper: a blocker that cannot start is logged and retried next time', () => {
  const logs = []
  let fail = true
  const blocker = { start() { if (fail) throw new Error('no power API'); return 7 }, stop() {} }
  const keeper = createAwakeKeeper({ powerSaveBlocker: blocker, sources: { a: () => true }, log: (m) => logs.push(m), setIntervalFn: () => ({}), clearIntervalFn() {} })
  assert.doesNotThrow(() => keeper.evaluate())
  assert.equal(keeper.status().holding, false)
  fail = false
  keeper.evaluate()
  assert.equal(keeper.status().holding, true)
  assert.match(logs.join(' '), /no power API/)
})

test('the warning text and the Windows power-settings link are what the tray and Settings show', () => {
  assert.match(SLEEP_NOTE, /only while someone is watching or a task is running/)
  assert.match(SLEEP_NOTE, /sleep/)
  assert.equal(POWER_SETTINGS_URI, 'ms-settings:powersleep')
})

// ---- resume recovery -----------------------------------------------------------
function resumeHarness(actions, opts) {
  const monitor = new EventEmitter()
  const timers = []
  let t = 5_000_000
  const rec = createResumeRecovery(Object.assign({
    powerMonitor: monitor, actions, now: () => t,
    setTimeoutFn: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer },
    clearTimeoutFn: (timer) => { timer.cleared = true }
  }, opts))
  rec.install()
  const run = async () => {
    // Fire every pending timer (in order) and let promises settle, until none are left.
    for (let guard = 0; guard < 50; guard++) {
      const next = timers.find((x) => !x.cleared && !x.done)
      if (!next) return
      next.done = true
      next.fn()
      await new Promise((r) => setImmediate(r))
    }
  }
  return { monitor, timers, rec, run, advance: (ms) => { t += ms } }
}

test('resume: every action runs after the first delay, and the ones that succeed are not retried', async () => {
  const ran = []
  const h = resumeHarness([
    { name: 'upnp', run: async () => { ran.push('upnp'); return true } },
    { name: 'home-address', run: async () => { ran.push('home-address'); return true } }
  ])
  h.monitor.emit('resume')
  assert.deepEqual(h.timers.map((x) => x.ms), [5000, 5000])
  await h.run()
  assert.deepEqual(ran, ['upnp', 'home-address'])
  assert.equal(h.timers.length, 2, 'no retry timers were scheduled')
})

test('resume: a failing action backs off 5 s, 20 s, 60 s, 3 min then gives up and says so', async () => {
  const logs = []
  let calls = 0
  const h = resumeHarness([{ name: 'license', run: async () => { calls++; return false } }], { log: (m) => logs.push(m) })
  h.monitor.emit('resume')
  await h.run()
  assert.equal(calls, 4)
  assert.deepEqual(h.timers.map((x) => x.ms), [5000, 15000, 40000, 120000], 'gaps between attempts are 5s, 20s, 60s, 180s from the wake-up')
  assert.match(logs.join('\n'), /license still not working after 4 tries/)
})

test('resume: an action that throws is retried and never breaks the others', async () => {
  const seen = []
  let n = 0
  const h = resumeHarness([
    { name: 'flaky', run: async () => { n++; if (n < 3) throw new Error('offline'); seen.push('flaky ok'); return true } },
    { name: 'steady', run: async () => { seen.push('steady ok'); return true } }
  ])
  h.monitor.emit('resume')
  await h.run()
  assert.deepEqual(seen.sort(), ['flaky ok', 'steady ok'])
  assert.equal(h.rec.status().flaky.ok, true)
  assert.equal(h.rec.status().flaky.attempts, 3)
})

test('resume: sleeping again cancels the pending retries; a new wake-up starts over', async () => {
  let calls = 0
  const h = resumeHarness([{ name: 'x', run: async () => { calls++; return false } }])
  h.monitor.emit('resume')
  h.timers[0].done = true; h.timers[0].fn()
  await new Promise((r) => setImmediate(r))
  const pending = h.timers.filter((t) => !t.cleared && !t.done)
  assert.equal(pending.length, 1)
  h.monitor.emit('suspend')
  assert.ok(pending[0].cleared)
  const before = calls
  h.monitor.emit('resume')
  await h.run()
  assert.ok(calls > before)
})

test('resume: unlocking the screen only re-checks if it has been a long while', async () => {
  let calls = 0
  const h = resumeHarness([{ name: 'x', run: async () => { calls++; return true } }])
  h.monitor.emit('resume'); await h.run()
  assert.equal(calls, 1)
  h.advance(60 * 1000)
  h.monitor.emit('unlock-screen'); await h.run()
  assert.equal(calls, 1, 'one minute later: ignored')
  h.advance(20 * 60 * 1000)
  h.monitor.emit('unlock-screen'); await h.run()
  assert.equal(calls, 2)
})
