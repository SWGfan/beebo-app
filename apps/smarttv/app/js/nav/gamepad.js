// Game-controller mapping (Xbox and any other gamepad). DOM-free and pure, so it is unit-tested in
// plain Node (test/gamepad.test.mjs). Two independent inputs feed the SAME action names that
// keys.js already speaks ('up' 'down' 'left' 'right' 'enter' 'back' 'playpause' 'ff' 'rw' ...):
//
//  1. Virtual-key codes. On Xbox the WebView2 host turns the controller into keyboard events whose
//     keyCode is the Windows.System.VirtualKey value (GamepadA = 195 ... GamepadRightThumbstickLeft = 218,
//     plus the NavigationUp/Down/... family 136-143). Source of the numbers: Microsoft Learn,
//     "VirtualKey Enum (Windows.System)". keys.js consults GAMEPAD_CODES for these.
//
//  2. The standard W3C Gamepad API (navigator.getGamepads()). Used as a fallback when a browser or a
//     WebView delivers no virtual-key events (and for testing on a desktop with a USB / Bluetooth
//     controller). createGamepadPoller() turns button snapshots into actions with edge detection and
//     auto-repeat for the D-pad, stick and seek triggers. It stays silent as soon as virtual-key
//     events are seen, so one press is never delivered twice.
//
// Layout (Microsoft's own guidance, "Gamepad and remote control interactions": A select, B back,
// Menu opens a context menu, Y is the search shortcut, triggers page / scrub):
//   A select | B back | X play-pause | Y search | Menu options | View info/OSD
//   D-pad / left stick move focus | LT rewind (seek back) | RT fast-forward (seek forward)
//   LB previous | RB next
// The Xbox (Guide) button belongs to the console: the app never receives it and cannot change it.

// ---- virtual-key codes -> action names ------------------------------------------------------------------

export var VK = {
  GamepadA: 195, GamepadB: 196, GamepadX: 197, GamepadY: 198,
  GamepadRightShoulder: 199, GamepadLeftShoulder: 200,
  GamepadLeftTrigger: 201, GamepadRightTrigger: 202,
  GamepadDPadUp: 203, GamepadDPadDown: 204, GamepadDPadLeft: 205, GamepadDPadRight: 206,
  GamepadMenu: 207, GamepadView: 208,
  GamepadLeftThumbstickButton: 209, GamepadRightThumbstickButton: 210,
  GamepadLeftThumbstickUp: 211, GamepadLeftThumbstickDown: 212, GamepadLeftThumbstickRight: 213, GamepadLeftThumbstickLeft: 214,
  GamepadRightThumbstickUp: 215, GamepadRightThumbstickDown: 216, GamepadRightThumbstickRight: 217, GamepadRightThumbstickLeft: 218,
  NavigationView: 136, NavigationMenu: 137, NavigationUp: 138, NavigationDown: 139, NavigationLeft: 140,
  NavigationRight: 141, NavigationAccept: 142, NavigationCancel: 143,
  GoBack: 166
}

export var GAMEPAD_CODES = {
  195: 'enter', // A
  196: 'back', // B
  197: 'playpause', // X
  198: 'search', // Y
  199: 'next', // RB
  200: 'prev', // LB
  201: 'rw', // LT
  202: 'ff', // RT
  203: 'up', 204: 'down', 205: 'left', 206: 'right', // D-pad
  207: 'menu', // Menu
  208: 'info', // View
  209: 'ignore', 210: 'ignore', // stick clicks
  211: 'up', 212: 'down', 213: 'right', 214: 'left', // left stick
  215: 'ignore', 216: 'ignore', 217: 'ignore', 218: 'ignore', // right stick: unused
  136: 'info', 137: 'menu', // NavigationView / NavigationMenu (remote-style keys)
  138: 'up', 139: 'down', 140: 'left', 141: 'right', 142: 'enter', 143: 'back',
  166: 'back' // GoBack
}

/** The action for a virtual-key code, or null when it is not a gamepad / navigation code. */
export function gamepadActionForCode(code) {
  if (typeof code !== 'number' || !isFinite(code)) return null
  return Object.prototype.hasOwnProperty.call(GAMEPAD_CODES, code) ? GAMEPAD_CODES[code] : null
}

/** True for the Gamepad* virtual keys (195-218): proof that the host delivers controller key events. */
export function isGamepadVirtualKey(code) {
  return typeof code === 'number' && code >= 195 && code <= 218
}

// ---- back-press de-duplication --------------------------------------------------------------------------

/**
 * On Xbox one physical B press can reach the app twice: as a key event inside the web page and as the
 * host's system "back requested" call. Returns true when this Back should be DROPPED because another one
 * was accepted less than windowMs ago. windowMs <= 0 (other platforms) never drops anything.
 */
export function shouldDropBack(lastAcceptedAt, now, windowMs) {
  if (!(windowMs > 0)) return false
  if (typeof lastAcceptedAt !== 'number' || !isFinite(lastAcceptedAt)) return false
  return now - lastAcceptedAt >= 0 && now - lastAcceptedAt < windowMs
}

// ---- W3C Gamepad API poller (fallback + desktop testing) --------------------------------------------------

// "standard" mapping button indices (https://w3c.github.io/gamepad/#remapping). Index 16 (the Guide /
// Xbox button) is deliberately absent: the console keeps it.
var BUTTON_ACTIONS = [
  [0, 'enter'], [1, 'back'], [2, 'playpause'], [3, 'search'],
  [4, 'prev'], [5, 'next'], [6, 'rw'], [7, 'ff'],
  [8, 'info'], [9, 'menu'],
  [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']
]
var REPEATING = { up: 1, down: 1, left: 1, right: 1, rw: 1, ff: 1 }
var STICK_THRESHOLD = 0.6

function isDown(b) {
  if (!b) return false
  if (typeof b === 'number') return b > 0.5
  return b.pressed === true || (typeof b.value === 'number' && b.value > 0.5)
}

/** The set of action names currently held on one pad snapshot: { up: true, enter: true, ... }. */
export function actionsHeld(pad) {
  var held = {}
  if (!pad || !pad.buttons) return held
  for (var i = 0; i < BUTTON_ACTIONS.length; i++) {
    if (isDown(pad.buttons[BUTTON_ACTIONS[i][0]])) held[BUTTON_ACTIONS[i][1]] = true
  }
  var ax = pad.axes || []
  if (typeof ax[0] === 'number') { if (ax[0] <= -STICK_THRESHOLD) held.left = true; else if (ax[0] >= STICK_THRESHOLD) held.right = true }
  if (typeof ax[1] === 'number') { if (ax[1] <= -STICK_THRESHOLD) held.up = true; else if (ax[1] >= STICK_THRESHOLD) held.down = true }
  return held
}

/**
 * @param {{getPads:function():Array, now:function():number, emit:function(string):void,
 *          repeatDelayMs?:number, repeatEveryMs?:number}} opts
 * @returns {{poll:function():void, noteKeyEvent:function(number):void, isSilenced:function():boolean}}
 *
 * poll() is called every ~50 ms by the host. A press emits once when it starts; directions and the seek
 * triggers repeat while held (after repeatDelayMs, every repeatEveryMs). noteKeyEvent(keyCode) should be
 * called for every keydown: once a Gamepad* virtual key has been seen the poller goes silent for good.
 */
export function createGamepadPoller(opts) {
  var delay = opts.repeatDelayMs > 0 ? opts.repeatDelayMs : 400
  var every = opts.repeatEveryMs > 0 ? opts.repeatEveryMs : 110
  var down = {} // action -> { since, last }
  var silenced = false

  function poll() {
    if (silenced) return
    var pads = opts.getPads() || []
    var held = {}
    for (var p = 0; p < pads.length; p++) {
      var one = actionsHeld(pads[p])
      for (var k in one) if (Object.prototype.hasOwnProperty.call(one, k)) held[k] = true
    }
    var now = opts.now()
    var name
    for (name in held) {
      if (!Object.prototype.hasOwnProperty.call(held, name)) continue
      var st = down[name]
      if (!st) {
        down[name] = { since: now, last: now }
        opts.emit(name)
      } else if (REPEATING[name] && now - st.since >= delay && now - st.last >= every) {
        st.last = now
        opts.emit(name)
      }
    }
    for (name in down) {
      if (Object.prototype.hasOwnProperty.call(down, name) && !held[name]) delete down[name]
    }
  }

  return {
    poll: poll,
    noteKeyEvent: function (keyCode) { if (isGamepadVirtualKey(keyCode)) silenced = true },
    isSilenced: function () { return silenced }
  }
}
