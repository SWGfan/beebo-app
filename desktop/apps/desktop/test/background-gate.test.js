'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const gate = require('../electron/backgroundGate')

test.beforeEach(() => { gate.reset(); delete process.env.BEEBO_BACKGROUND_ALWAYS })

test('with nothing configured the gate never holds anything back', () => {
  assert.deepEqual(gate.check(), { defer: false, reason: null })
})

test('playback holds background work back, and the reason says so', () => {
  let playing = true
  gate.configure({ playing: () => playing })
  assert.deepEqual(gate.check(), { defer: true, reason: 'playback' })
  playing = false
  assert.equal(gate.shouldDefer(), false)
})

test('battery power holds it back unless the owner turned that off', () => {
  const settings = {}
  gate.configure({ battery: () => true, setting: (k, d) => (k in settings ? settings[k] : d) })
  assert.deepEqual(gate.check(), { defer: true, reason: 'battery' })
  settings.backgroundPauseOnBattery = false
  assert.equal(gate.check().defer, false)
})

test('a caller can ignore a reason it handles itself; playback wins over battery in the answer', () => {
  gate.configure({ playing: () => true, battery: () => true })
  assert.equal(gate.check().reason, 'playback')
  assert.equal(gate.check({ ignore: ['playback'] }).reason, 'battery')
  assert.equal(gate.check({ ignore: ['playback', 'battery'] }).defer, false)
})

test('a probe that throws is treated as "no", never as a reason to stall forever', () => {
  gate.configure({ playing: () => { throw new Error('boom') }, battery: () => { throw new Error('boom') } })
  assert.equal(gate.check().defer, false)
})

test('BEEBO_BACKGROUND_ALWAYS=1 switches the gate off', () => {
  gate.configure({ playing: () => true, battery: () => true })
  process.env.BEEBO_BACKGROUND_ALWAYS = '1'
  assert.equal(gate.check().defer, false)
})

test('runWhenClear runs at once when clear, retries while held back, and gives up waiting after maxWaits', async () => {
  const fired = []
  const timers = { setTimeout: (fn) => { fired.push(fn); return { unref() {} } } }
  let playing = true
  gate.configure({ playing: () => playing })
  let ran = 0
  const p = gate.runWhenClear(() => { ran++; return 'ok' }, { timers, retryMs: 1 })
  assert.equal(ran, 0)
  assert.equal(fired.length, 1, 'waiting')
  playing = false
  fired.shift()()
  assert.equal(await p, 'ok')
  assert.equal(ran, 1)

  playing = true
  const p2 = gate.runWhenClear(() => 'late', { timers, retryMs: 1, maxWaits: 2 })
  fired.shift()()
  fired.shift()()
  assert.equal(await p2, 'late', 'after maxWaits it runs anyway: late, never skipped')

  gate.configure({ playing: () => false })
  await assert.rejects(gate.runWhenClear(() => { throw new Error('nope') }), /nope/)
})

test('busy needs the CPU to stay nearly full over two samples, and honours its setting', () => {
  const os = require('node:os')
  const real = os.cpus
  let busy = 0
  let idle = 0
  os.cpus = () => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }]
  try {
    let settings = {}
    gate.configure({ setting: (k, d) => (k in settings ? settings[k] : d) })
    const at = (t) => gate.sampleCpu(t)
    at(1000) // first sample: nothing to compare with
    busy += 980; idle += 20
    at(6000)
    assert.equal(gate.check({ now: 6000 }).defer, false, 'one busy sample is a spike, not a state')
    busy += 990; idle += 10
    at(11000)
    assert.deepEqual(gate.check({ now: 11000 }), { defer: true, reason: 'busy' })
    settings = { backgroundPauseWhenBusy: false }
    assert.equal(gate.check({ now: 11000 }).defer, false)
    settings = {}
    busy += 100; idle += 900
    at(16000)
    assert.equal(gate.check({ now: 16000 }).defer, false, 'clears as soon as the CPU calms down')
  } finally { os.cpus = real }
})
