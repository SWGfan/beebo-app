// Remote-control key mapping. DOM-free.
//
// Key codes (KeyboardEvent.keyCode) seen on TVs:
//   Common       : arrows 37-40, OK/Enter 13
//   Tizen        : Back 10009, Play 415, Pause 19, PlayPause 10252, Stop 413, FF 417, RW 412,
//                  Prev 10232, Next 10233, Info 457, Menu 10133, colours 403-406
//   webOS        : Back 461, Play 415, Pause 19, Stop 413, FF 417, RW 412, Info 457, colours 403-406
//   Desktop (dev): Backspace 8 / Escape 27 = Back, Space = play/pause, ContextMenu = menu (letters are
//                  left alone so a USB/desktop keyboard can type into the on-screen fields)
// The same codes are used by both platforms except Back, so one table serves both.
//
// Game controllers (Xbox): virtual-key codes 136-143, 166 and 195-218 live in gamepad.js (one table,
// unit-tested). None of them collide with the codes above, so one lookup order serves every platform.
//
// Anything not listed (numbers, colour keys, volume, channel, ...) maps to 'ignore' when it is a
// known-but-unused remote key, or null when we know nothing about it. Callers must not call
// preventDefault for null (so the TV's own volume/mute handling is untouched).

import { gamepadActionForCode } from './gamepad.js'

var CODES = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down',
  13: 'enter', 32: 'playpause',
  8: 'back', 27: 'back', 461: 'back', 10009: 'back',
  415: 'play', 19: 'pause', 10252: 'playpause', 413: 'stop',
  417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev',
  457: 'info', 10133: 'menu',
  // colour keys: red, green, yellow, blue - reserved for later; ignored gracefully
  403: 'ignore', 404: 'ignore', 405: 'ignore', 406: 'ignore'
}

var KEY_NAMES = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Enter: 'enter', Escape: 'back', Backspace: 'back', GoBack: 'back', BrowserBack: 'back',
  MediaPlay: 'play', MediaPause: 'pause', MediaPlayPause: 'playpause', MediaStop: 'stop',
  MediaFastForward: 'ff', MediaRewind: 'rw', MediaTrackNext: 'next', MediaTrackPrevious: 'prev',
  Info: 'info', ContextMenu: 'menu',
  ColorF0Red: 'ignore', ColorF1Green: 'ignore', ColorF2Yellow: 'ignore', ColorF3Blue: 'ignore'
}

/** Names accepted by tizen.tvinputdevice.registerKey() for the keys we handle. */
export var TIZEN_KEY_NAMES = [
  'MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop',
  'MediaFastForward', 'MediaRewind', 'MediaTrackPrevious', 'MediaTrackNext',
  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info'
]

/**
 * @param {{keyCode?:number, key?:string}} ev
 * @returns {string|null} 'up'|'down'|'left'|'right'|'enter'|'back'|'play'|'pause'|'playpause'|
 *                        'stop'|'ff'|'rw'|'next'|'prev'|'info'|'menu'|'search'|'ignore'|null
 */
export function keyToAction(ev) {
  if (!ev) return null
  var code = ev.keyCode
  if (typeof code !== 'number' || !isFinite(code)) code = ev.which
  if (typeof code === 'number' && CODES[code]) return CODES[code]
  var pad = gamepadActionForCode(code)
  if (pad) return pad
  if (ev.key && KEY_NAMES[ev.key]) return KEY_NAMES[ev.key]
  return null
}

/** Directions only, or null. */
export function directionOf(action) {
  return action === 'up' || action === 'down' || action === 'left' || action === 'right' ? action : null
}
