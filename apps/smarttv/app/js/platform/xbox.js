// Xbox (One / Series) host glue. The app runs inside a full-screen WebView2 in a small UWP shell
// (apps/xbox). Everything here is guarded so a missing host object never throws.
//
// The shell talks to the page in two directions, both plain JSON strings:
//   page  -> shell : window.chrome.webview.postMessage(JSON.stringify({ type, ... }))
//                    types: 'playback' {state:'playing'|'paused'|'stopped'}  keeps the console awake during video
//                           'backstate' {canGoBack:boolean}                  lets the shell hand Back to the system
//                           'exit'                                           page is at its root
//   shell -> page  : window.__beeboXbox = { deviceForm, host, version }     set before any page script runs
//                    window.beeboXbox.back()    system "back requested" (B / remote Back)
//                    window.beeboXbox.media(k)  media remote buttons: 'play' 'pause' 'playpause' 'stop' 'next' 'prev' 'ff' 'rw'

import { createGamepadPoller } from '../nav/gamepad.js'
import { createSourceAttacher } from './hls.js'

// One physical B press can arrive as a key event AND as the shell's back-requested call.
export var BACK_DEBOUNCE_MS = 300
export var POLL_MS = 50

var MEDIA_ACTIONS = { play: 'play', pause: 'pause', playpause: 'playpause', stop: 'stop', next: 'next', prev: 'prev', previous: 'prev', ff: 'ff', rw: 'rw' }

/** hls.js mode from the address: ?hls=js or ?hls=native forces a side; anything else is automatic. */
export function hlsModeFromSearch(search) {
  var m = /[?&]hls=(js|native)(?:&|$)/.exec(String(search || ''))
  return m ? m[1] : 'auto'
}

/**
 * True on the console (the shell sets window.__beeboXbox, or the user agent says Xbox). Also true when the
 * address has ?xbox=1: a development switch that lets you try the controller and HLS paths in desktop Chrome
 * against the mock server (see apps/xbox/README.md). It only selects the Xbox input paths; it grants nothing.
 */
export function isXboxHost(win) {
  try {
    if (win && win.__beeboXbox) return true
    if (win && win.location && /[?&]xbox=1(?:&|$)/.test(String(win.location.search || ''))) return true
    var ua = String((win && win.navigator && win.navigator.userAgent) || '')
    return /Xbox/i.test(ua)
  } catch (e) { return false }
}

export function createXbox(win) {
  var mode = 'auto'
  try { mode = hlsModeFromSearch(win.location && win.location.search) } catch (e) { mode = 'auto' }
  var attacher = createSourceAttacher(win, { mode: mode })
  var watched = null // the <video> whose events are mirrored to the shell
  var dispatch = null // set by installInput
  var lastBackState = null
  var timer = null
  var poller = null

  function post(obj) {
    try {
      var wv = win.chrome && win.chrome.webview
      if (wv && typeof wv.postMessage === 'function') wv.postMessage(JSON.stringify(obj))
    } catch (e) { /* no host: plain browser test */ }
  }

  function watch(video) {
    if (watched === video || !video || typeof video.addEventListener !== 'function') return
    watched = video
    function state(s) { return function () { post({ type: 'playback', state: s }) } }
    video.addEventListener('playing', state('playing'))
    video.addEventListener('pause', state('paused'))
    video.addEventListener('ended', state('stopped'))
    video.addEventListener('emptied', state('stopped'))
  }

  function deviceForm() {
    try { return String((win.__beeboXbox && win.__beeboXbox.deviceForm) || '') } catch (e) { return '' }
  }

  return {
    backDebounceMs: BACK_DEBOUNCE_MS,
    deviceName: 'Beebo on Xbox',
    deviceModel: function () { var f = deviceForm(); return f ? 'xbox ' + f : 'xbox' },

    attachSource: function (video, url) {
      watch(video)
      return attacher.attach(video, url)
    },
    detachSource: function (video) { attacher.detach(video); post({ type: 'playback', state: 'stopped' }) },
    engine: function (video) { return attacher.engine(video) },

    /**
     * Wire everything that produces actions but is not a keydown: the shell's Back and media-remote calls,
     * and the Gamepad API fallback. `send(action)` runs an action through the app's normal path.
     */
    installInput: function (send) {
      dispatch = send
      win.beeboXbox = {
        back: function () { if (dispatch) dispatch('back') },
        media: function (k) { var key = String(k); var a = Object.prototype.hasOwnProperty.call(MEDIA_ACTIONS, key) ? MEDIA_ACTIONS[key] : null; if (a && dispatch) dispatch(a) }
      }
      poller = createGamepadPoller({
        getPads: function () { try { return win.navigator.getGamepads ? win.navigator.getGamepads() : [] } catch (e) { return [] } },
        now: function () { return Date.now() },
        emit: function (a) { if (dispatch) dispatch(a) }
      })
      if (typeof win.setInterval === 'function') timer = win.setInterval(function () { poller.poll() }, POLL_MS)
      return { stop: function () { if (timer && typeof win.clearInterval === 'function') win.clearInterval(timer); timer = null } }
    },

    /** Called for every keydown so the fallback poller can go quiet once real gamepad key events flow. */
    noteKey: function (ev) { if (poller && ev) poller.noteKeyEvent(ev.keyCode) },

    /** Tell the shell whether the page can use a Back press (else the shell lets the system go Home). */
    reportBackState: function (canGoBack) {
      var b = !!canGoBack
      if (b === lastBackState) return
      lastBackState = b
      post({ type: 'backstate', canGoBack: b })
    },

    exit: function () { post({ type: 'exit' }) }
  }
}
