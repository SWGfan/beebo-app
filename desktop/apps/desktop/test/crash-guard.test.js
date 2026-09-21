'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createCrashGuard, RENDERER_RELOAD_LIMIT } = require('../electron/crashGuard')

function harness(over) {
  const proc = new EventEmitter()
  const app = new EventEmitter()
  app.whenReady = () => Promise.resolve()
  const logs = []
  const shown = []
  const clip = []
  const saved = []
  const exits = []
  let script = ['close']
  const dialog = {
    showMessageBox: async (o) => { shown.push(o); const pick = script.shift() || 'close'; return { response: o.buttons ? (pick === 'copy' ? 0 : pick === 'save' ? 1 : 2) : 0 } },
    showErrorBox: (t, m) => shown.push({ errorBox: true, t, m })
  }
  const timers = []
  const guard = createCrashGuard(Object.assign({
    app, dialog, proc,
    clipboard: { writeText: (t) => clip.push(t) },
    log: (m) => logs.push(m),
    buildDiagnostics: async (err) => 'REPORT ' + (err && err.message),
    saveDiagnostics: async (t) => { saved.push(t); return 'C:\\Users\\x\\Desktop\\beebo-diagnostics.txt' },
    exit: (c) => exits.push(c),
    setTimeoutFn: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }
  }, over))
  guard.install()
  return { proc, app, guard, logs, shown, clip, saved, exits, timers, setScript: (s) => { script = s } }
}
const tick = () => new Promise((r) => setImmediate(r))

test('an uncaught exception after startup is logged and Beebo keeps running', async () => {
  const h = harness()
  h.guard.markStarted()
  h.proc.emit('uncaughtException', new Error('handler blew up'))
  await tick()
  assert.equal(h.exits.length, 0)
  assert.equal(h.shown.length, 0)
  assert.match(h.logs.join('\n'), /uncaughtException: Error: handler blew up/)
})

test('an unhandled rejection is logged and never fatal, even before startup finishes', async () => {
  const h = harness()
  h.proc.emit('unhandledRejection', new Error('best-effort promise failed'))
  await tick()
  assert.equal(h.shown.length, 0)
  assert.equal(h.exits.length, 0)
  assert.match(h.logs.join('\n'), /unhandledRejection: Error: best-effort promise failed/)
})

test('a failure while starting is fatal: plain-language dialog with Copy diagnostics, then exit', async () => {
  const h = harness()
  h.setScript(['copy', 'close'])
  h.proc.emit('uncaughtException', new Error('Cannot find module \'./streamServer\''))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.shown.length, 2, 'shown again after copying, with a confirmation')
  const first = h.shown[0]
  assert.equal(first.type, 'error')
  assert.deepEqual(first.buttons, ['Copy diagnostics', 'Save diagnostics file', 'Close'])
  assert.match(first.message, /ran into a problem while starting/)
  assert.match(first.detail, /videos and photos were not touched/)
  assert.match(first.detail, /Cannot find module/)
  assert.doesNotMatch(first.detail + first.message, /at .*\.js:\d+/, 'no stack trace in front of the person')
  assert.deepEqual(h.clip, ['REPORT Cannot find module \'./streamServer\''])
  assert.match(h.shown[1].detail, /Copied/)
  assert.deepEqual(h.exits, [1])
  assert.match(h.logs.join('\n'), /FATAL while starting/)
})

test('fatal startup: Save diagnostics file writes the report and says where', async () => {
  const h = harness()
  h.setScript(['save', 'close'])
  await h.guard.fatalStartup(new Error('boom'))
  assert.deepEqual(h.saved, ['REPORT boom'])
  assert.match(h.shown[1].detail, /beebo-diagnostics\.txt/)
})

test('fatal startup is shown only once even if several errors follow', async () => {
  const h = harness()
  h.proc.emit('uncaughtException', new Error('first'))
  h.proc.emit('uncaughtException', new Error('second'))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.shown.length, 1)
  assert.deepEqual(h.exits, [1])
})

test('fatal startup: the dialog appears only once the app is ready, and does not wait for ever', async () => {
  let ready
  const h = harness({})
  h.app.whenReady = () => new Promise((r) => { ready = r })
  const p = h.guard.fatalStartup(new Error('early'))
  await tick()
  assert.equal(h.shown.length, 0)
  ready()
  await p
  assert.equal(h.shown.length, 1)

  const h2 = harness({})
  h2.app.whenReady = () => new Promise(() => {})
  const p2 = h2.guard.fatalStartup(new Error('never ready'))
  await tick()
  h2.timers[0].fn()
  await p2
  assert.equal(h2.shown.length, 1)
  assert.deepEqual(h2.exits, [1])
})

test('a broken diagnostics builder still gives the person something to send', async () => {
  const h = harness({ buildDiagnostics: () => { throw new Error('diag failed') } })
  h.setScript(['copy', 'close'])
  await h.guard.fatalStartup(new Error('original problem'))
  assert.match(h.clip[0], /could not be fully built \(diag failed\)/)
  assert.match(h.clip[0], /Last error: original problem/)
})

test('if even the dialog fails, an error box is shown and Beebo still exits', async () => {
  const h = harness()
  h.shown.length = 0
  const failing = { showMessageBox: async () => { throw new Error('no window system') }, showErrorBox: (t, m) => h.shown.push({ errorBox: true, t, m }) }
  const h2 = harness({ dialog: failing })
  await h2.guard.fatalStartup(new Error('x'))
  assert.equal(h.shown.length, 1, 'the fallback error box was shown')
  assert.deepEqual(h2.exits, [1])
})

test('a closed stdout pipe (EPIPE) while starting is not a reason to refuse to start', async () => {
  const h = harness()
  const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  h.proc.emit('uncaughtException', err)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.shown.length, 0)
  assert.equal(h.exits.length, 0)
})

test('an exception storm is logged briefly, not for ever', async () => {
  let t = 0
  const h = harness({ now: () => t })
  h.guard.markStarted()
  for (let i = 0; i < 500; i++) { t += 10; h.proc.emit('uncaughtException', new Error('loop ' + i)) }
  assert.ok(h.logs.length < 40, 'logged ' + h.logs.length + ' lines')
  assert.match(h.logs.join('\n'), /repeating rapidly/)
})

test('a crashed window reloads itself, up to the limit, then stops and says why', async () => {
  let t = 0
  const h = harness({ now: () => t })
  const reloads = []
  const wc = { isDestroyed: () => false, reload: () => reloads.push(t) }
  for (let i = 0; i < RENDERER_RELOAD_LIMIT + 2; i++) {
    t += 60000
    h.app.emit('render-process-gone', {}, wc, { reason: 'crashed', exitCode: 139 })
  }
  for (const timer of h.timers) timer.fn()
  assert.equal(reloads.length, RENDERER_RELOAD_LIMIT)
  assert.equal(h.shown.filter((s) => s.title === 'Beebo window problem').length, 2)
  assert.match(h.shown[0].detail, /still running in the background/)
  assert.match(h.logs.join('\n'), /window process gone: reason=crashed exitCode=139/)
})

test('a window closed on purpose (clean-exit / killed) is not reloaded', () => {
  const h = harness()
  const wc = { isDestroyed: () => false, reload() { throw new Error('should not reload') } }
  h.app.emit('render-process-gone', {}, wc, { reason: 'clean-exit', exitCode: 0 })
  h.app.emit('render-process-gone', {}, wc, { reason: 'killed', exitCode: 1 })
  for (const timer of h.timers) timer.fn()
})

test('other Electron child processes are logged; clean exits are not', () => {
  const h = harness()
  h.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 3 })
  h.app.emit('child-process-gone', {}, { type: 'Utility', reason: 'clean-exit', exitCode: 0 })
  assert.equal(h.logs.length, 1)
  assert.match(h.logs[0], /GPU process gone: reason=crashed exitCode=3/)
})
