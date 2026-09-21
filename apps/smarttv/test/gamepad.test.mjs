import test from 'node:test'
import assert from 'node:assert/strict'
import { VK, GAMEPAD_CODES, gamepadActionForCode, isGamepadVirtualKey, shouldDropBack, actionsHeld, createGamepadPoller } from '../app/js/nav/gamepad.js'
import { keyToAction, directionOf } from '../app/js/nav/keys.js'

// ---- virtual-key table -----------------------------------------------------------------------------------------

test('VK numbers are the Windows.System.VirtualKey values (Microsoft Learn, VirtualKey Enum)', () => {
  assert.equal(VK.GamepadA, 195)
  assert.equal(VK.GamepadB, 196)
  assert.equal(VK.GamepadX, 197)
  assert.equal(VK.GamepadY, 198)
  assert.equal(VK.GamepadRightShoulder, 199)
  assert.equal(VK.GamepadLeftShoulder, 200)
  assert.equal(VK.GamepadLeftTrigger, 201)
  assert.equal(VK.GamepadRightTrigger, 202)
  assert.equal(VK.GamepadDPadUp, 203)
  assert.equal(VK.GamepadDPadRight, 206)
  assert.equal(VK.GamepadMenu, 207)
  assert.equal(VK.GamepadView, 208)
  assert.equal(VK.GamepadLeftThumbstickUp, 211)
  assert.equal(VK.GamepadLeftThumbstickLeft, 214)
  assert.equal(VK.NavigationUp, 138)
  assert.equal(VK.NavigationAccept, 142)
  assert.equal(VK.NavigationCancel, 143)
  assert.equal(VK.GoBack, 166)
})

test('the requested layout: A=select B=back X/Y=actions D-pad=focus LT/RT=seek Menu=options', () => {
  assert.equal(gamepadActionForCode(VK.GamepadA), 'enter')
  assert.equal(gamepadActionForCode(VK.GamepadB), 'back')
  assert.equal(gamepadActionForCode(VK.GamepadX), 'playpause')
  assert.equal(gamepadActionForCode(VK.GamepadY), 'search')
  assert.equal(gamepadActionForCode(VK.GamepadDPadUp), 'up')
  assert.equal(gamepadActionForCode(VK.GamepadDPadDown), 'down')
  assert.equal(gamepadActionForCode(VK.GamepadDPadLeft), 'left')
  assert.equal(gamepadActionForCode(VK.GamepadDPadRight), 'right')
  assert.equal(gamepadActionForCode(VK.GamepadLeftThumbstickUp), 'up')
  assert.equal(gamepadActionForCode(VK.GamepadLeftThumbstickRight), 'right')
  assert.equal(gamepadActionForCode(VK.GamepadLeftTrigger), 'rw')
  assert.equal(gamepadActionForCode(VK.GamepadRightTrigger), 'ff')
  assert.equal(gamepadActionForCode(VK.GamepadMenu), 'menu')
  assert.equal(gamepadActionForCode(VK.GamepadView), 'info')
  assert.equal(gamepadActionForCode(VK.GamepadLeftShoulder), 'prev')
  assert.equal(gamepadActionForCode(VK.GamepadRightShoulder), 'next')
  assert.equal(gamepadActionForCode(VK.GoBack), 'back')
  assert.equal(gamepadActionForCode(VK.NavigationCancel), 'back')
})

test('every table entry is a number key in 136-218 and a known action; unknown codes give null', () => {
  const ACTIONS = new Set(['up', 'down', 'left', 'right', 'enter', 'back', 'playpause', 'search', 'next', 'prev', 'rw', 'ff', 'menu', 'info', 'ignore'])
  for (const [code, action] of Object.entries(GAMEPAD_CODES)) {
    assert.ok(ACTIONS.has(action), code + ' -> ' + action)
    assert.ok(Number(code) === 166 || (Number(code) >= 136 && Number(code) <= 218), 'code range ' + code)
  }
  assert.equal(gamepadActionForCode(65), null) // letter A on a keyboard
  assert.equal(gamepadActionForCode(13), null) // Enter is keys.js's, not ours
  assert.equal(gamepadActionForCode(NaN), null)
  assert.equal(gamepadActionForCode('195'), null)
  assert.equal(gamepadActionForCode(undefined), null)
  assert.equal(gamepadActionForCode(-1), null)
})

test('the stick clicks and right stick are ignored gracefully (not unknown, so the page still swallows them)', () => {
  for (const c of [209, 210, 215, 216, 217, 218]) assert.equal(gamepadActionForCode(c), 'ignore')
})

test('isGamepadVirtualKey covers exactly 195-218', () => {
  assert.equal(isGamepadVirtualKey(194), false)
  assert.equal(isGamepadVirtualKey(195), true)
  assert.equal(isGamepadVirtualKey(218), true)
  assert.equal(isGamepadVirtualKey(219), false)
  assert.equal(isGamepadVirtualKey(138), false) // NavigationUp also comes from a plain remote
  assert.equal(isGamepadVirtualKey('200'), false)
})

// ---- keys.js integration (same table, no conflicts with the Tizen / webOS / desktop codes) --------------------------

test('keyToAction understands the gamepad codes and directionOf still classifies them', () => {
  assert.equal(keyToAction({ keyCode: 195 }), 'enter')
  assert.equal(keyToAction({ keyCode: 196 }), 'back')
  assert.equal(keyToAction({ keyCode: 197 }), 'playpause')
  assert.equal(keyToAction({ keyCode: 198 }), 'search')
  assert.equal(keyToAction({ keyCode: 201 }), 'rw')
  assert.equal(keyToAction({ keyCode: 202 }), 'ff')
  assert.equal(keyToAction({ keyCode: 203 }), 'up')
  assert.equal(keyToAction({ keyCode: 214 }), 'left')
  assert.equal(directionOf(keyToAction({ keyCode: 204 })), 'down')
  assert.equal(directionOf(keyToAction({ keyCode: 195 })), null)
})

test('adding the gamepad codes changed nothing for the existing remotes and keyboards', () => {
  const expected = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter', 32: 'playpause', 8: 'back', 27: 'back', 461: 'back', 10009: 'back',
    415: 'play', 19: 'pause', 10252: 'playpause', 413: 'stop', 417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev', 457: 'info', 10133: 'menu',
    403: 'ignore', 404: 'ignore', 405: 'ignore', 406: 'ignore' }
  for (const [code, action] of Object.entries(expected)) assert.equal(keyToAction({ keyCode: Number(code) }), action, code)
  assert.equal(keyToAction({ keyCode: 65 }), null) // letters stay untouched
  assert.equal(keyToAction({ keyCode: 170 }), null) // volume-ish: left to the platform
  assert.equal(keyToAction({ key: 'ArrowDown' }), 'down')
})

// ---- back de-duplication ---------------------------------------------------------------------------------------------

test('shouldDropBack: only inside the window, never when the window is 0 (other platforms)', () => {
  assert.equal(shouldDropBack(1000, 1100, 300), true)
  assert.equal(shouldDropBack(1000, 1299, 300), true)
  assert.equal(shouldDropBack(1000, 1300, 300), false)
  assert.equal(shouldDropBack(1000, 5000, 300), false)
  assert.equal(shouldDropBack(1000, 1100, 0), false)
  assert.equal(shouldDropBack(1000, 1100, undefined), false)
  assert.equal(shouldDropBack(undefined, 1100, 300), false) // first ever Back
  assert.equal(shouldDropBack(2000, 1000, 300), false) // clock went backwards: do not swallow
})

// ---- Gamepad API poller --------------------------------------------------------------------------------------------------

function pad(pressedIdx, axes) {
  const buttons = []
  for (let i = 0; i < 17; i++) buttons.push({ pressed: pressedIdx.indexOf(i) >= 0, value: pressedIdx.indexOf(i) >= 0 ? 1 : 0 })
  return { buttons, axes: axes || [0, 0, 0, 0] }
}

function harness(extra) {
  let pads = []
  let t = 0
  const out = []
  const poller = createGamepadPoller(Object.assign({ getPads: () => pads, now: () => t, emit: (a) => out.push(a) }, extra || {}))
  return {
    poller, out,
    set(p) { pads = p },
    at(ms) { t = ms; poller.poll() }
  }
}

test('actionsHeld: the standard-mapping buttons, the left stick with a dead zone, and no Guide button', () => {
  assert.deepEqual(Object.keys(actionsHeld(pad([0]))), ['enter'])
  assert.deepEqual(Object.keys(actionsHeld(pad([1]))), ['back'])
  assert.deepEqual(Object.keys(actionsHeld(pad([2]))), ['playpause'])
  assert.deepEqual(Object.keys(actionsHeld(pad([3]))), ['search'])
  assert.deepEqual(Object.keys(actionsHeld(pad([6]))), ['rw'])
  assert.deepEqual(Object.keys(actionsHeld(pad([7]))), ['ff'])
  assert.deepEqual(Object.keys(actionsHeld(pad([9]))), ['menu'])
  assert.deepEqual(Object.keys(actionsHeld(pad([12]))), ['up'])
  assert.deepEqual(Object.keys(actionsHeld(pad([15]))), ['right'])
  assert.deepEqual(Object.keys(actionsHeld(pad([16]))), []) // Guide/Xbox button: never
  assert.deepEqual(Object.keys(actionsHeld(pad([], [0.3, -0.5]))), []) // inside the dead zone
  assert.deepEqual(Object.keys(actionsHeld(pad([], [-0.9, 0.1]))), ['left'])
  assert.deepEqual(Object.keys(actionsHeld(pad([], [0.1, 0.95]))), ['down'])
  assert.deepEqual(Object.keys(actionsHeld(pad([], [0, -1]))), ['up'])
  assert.deepEqual(actionsHeld(null), {})
  assert.deepEqual(actionsHeld({}), {})
})

test('actionsHeld: analog triggers that report only a value (no pressed flag) count when past half', () => {
  const buttons = new Array(17).fill(null).map(() => ({ pressed: false, value: 0 }))
  buttons[7] = { pressed: false, value: 0.8 }
  buttons[6] = { pressed: false, value: 0.2 }
  assert.deepEqual(Object.keys(actionsHeld({ buttons, axes: [] })), ['ff'])
  assert.deepEqual(Object.keys(actionsHeld({ buttons: [1, 0], axes: [] })), ['enter']) // plain numbers
})

test('poller: one press = one action; releasing and pressing again = another', () => {
  const h = harness()
  h.set([pad([0])])
  h.at(0)
  h.at(50)
  h.at(100)
  assert.deepEqual(h.out, ['enter'])
  h.set([pad([])])
  h.at(150)
  h.set([pad([0])])
  h.at(200)
  assert.deepEqual(h.out, ['enter', 'enter'])
})

test('poller: directions repeat after the delay and then at the repeat rate; B and A never repeat', () => {
  const h = harness({ repeatDelayMs: 400, repeatEveryMs: 100 })
  h.set([pad([13, 1])]) // D-pad down + B
  h.at(0)
  assert.deepEqual(h.out.slice().sort(), ['back', 'down'])
  h.out.length = 0
  h.at(200)
  h.at(399)
  assert.deepEqual(h.out, [])
  h.at(400)
  assert.deepEqual(h.out, ['down'])
  h.at(450)
  assert.deepEqual(h.out, ['down'])
  h.at(500)
  assert.deepEqual(h.out, ['down', 'down'])
  h.at(1000)
  h.at(1100)
  assert.equal(h.out.filter((a) => a === 'back').length, 0) // B fired once at the start, never again
})

test('poller: the RT / LT seek triggers repeat like a direction (holding scrubs)', () => {
  const h = harness({ repeatDelayMs: 300, repeatEveryMs: 100 })
  h.set([pad([7])])
  h.at(0)
  h.at(300)
  h.at(400)
  assert.deepEqual(h.out, ['ff', 'ff', 'ff'])
})

test('poller: two pads at once do not double-fire the same action, and a disconnected pad is fine', () => {
  const h = harness()
  h.set([pad([0]), pad([0])])
  h.at(0)
  assert.deepEqual(h.out, ['enter'])
  h.set([null, undefined])
  h.at(50)
  h.set([])
  h.at(100)
  assert.deepEqual(h.out, ['enter'])
})

test('poller: getPads returning null (browser without the API) is harmless', () => {
  const h = harness()
  h.set(null)
  h.at(0)
  assert.deepEqual(h.out, [])
})

test('poller: once a Gamepad virtual key has been seen it stays silent, so a press is not delivered twice', () => {
  const h = harness()
  h.poller.noteKeyEvent(65) // an ordinary letter key changes nothing
  assert.equal(h.poller.isSilenced(), false)
  h.poller.noteKeyEvent(13)
  assert.equal(h.poller.isSilenced(), false)
  h.set([pad([0])])
  h.at(0)
  assert.deepEqual(h.out, ['enter'])
  h.poller.noteKeyEvent(195) // the host is delivering GamepadA as a key
  assert.equal(h.poller.isSilenced(), true)
  h.set([pad([])])
  h.at(100)
  h.set([pad([0])])
  h.at(200)
  assert.deepEqual(h.out, ['enter']) // nothing more from the poller
})

test('poller: a button already held when the page starts is reported once (not ignored, not repeated as a press)', () => {
  const h = harness()
  h.set([pad([1])])
  h.at(0)
  h.at(1000)
  h.at(2000)
  assert.deepEqual(h.out, ['back'])
})
