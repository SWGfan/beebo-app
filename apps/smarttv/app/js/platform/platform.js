// Thin platform shim: Samsung Tizen vs LG webOS vs Xbox vs plain browser (dev).
// Everything platform-specific the app needs is here, each call guarded so a missing API never
// throws (the same code runs in a desktop browser during development).

import { TIZEN_KEY_NAMES } from '../nav/keys.js'
import { createXbox, isXboxHost } from './xbox.js'
import { isMovieNightUrl } from '../util/movienight.js'
import { probeEnv } from './capabilities.js'

export function detect() {
  try {
    if (isXboxHost(window)) return 'xbox'
    if (typeof window.tizen !== 'undefined') return 'tizen'
    var ua = String(navigator.userAgent || '')
    if (/Tizen/i.test(ua)) return 'tizen'
    if (/Web0S|webOS|NetCast/i.test(ua) || typeof window.webOS !== 'undefined' || typeof window.PalmSystem !== 'undefined') return 'webos'
  } catch (e) { /* fall through */ }
  return 'browser'
}

export function createPlatform() {
  var kind = detect()
  var xbox = kind === 'xbox' ? createXbox(window) : null

  function registerKeys() {
    if (kind !== 'tizen') return
    // Media keys are only delivered to the app after registration (Tizen). Failures are ignored:
    // an unsupported key on some model must not stop the others.
    try {
      var tv = window.tizen.tvinputdevice
      for (var i = 0; i < TIZEN_KEY_NAMES.length; i++) {
        try { tv.registerKey(TIZEN_KEY_NAMES[i]) } catch (e) { /* not on this model */ }
      }
    } catch (e) { /* tvinputdevice unavailable */ }
  }

  function exit() {
    if (xbox) { xbox.exit(); return }
    try {
      if (kind === 'tizen') { window.tizen.application.getCurrentApplication().exit(); return }
      if (kind === 'webos') {
        if (window.webOS && typeof window.webOS.platformBack === 'function') { window.webOS.platformBack(); return }
        window.close()
        return
      }
    } catch (e) { /* fall through */ }
    try { window.close() } catch (e2) { /* ignore */ }
  }

  // Leave the app for the server's own Movie Night screen (a web page the server draws). The ONLY navigation this app
  // makes, and it refuses anything that is not that page on the server the person chose (util/movienight.js).
  function openMovieNight(origin, url) {
    if (!isMovieNightUrl(origin, url)) return false
    try { window.location.assign(url); return true } catch (e) { return false }
  }

  function deviceModel() {
    if (xbox) return xbox.deviceModel()
    try {
      if (kind === 'tizen' && window.webapis && window.webapis.productinfo) return 'tizen ' + String(window.webapis.productinfo.getModel() || '')
    } catch (e) { /* ignore */ }
    return kind
  }

  var api = {
    kind: kind,
    registerKeys: registerKeys,
    exit: exit,
    openMovieNight: openMovieNight,
    deviceName: xbox ? xbox.deviceName : 'Beebo TV app',
    deviceModel: deviceModel,
    // What this TV can play and show, for the device profile sent to POST /api/playback/negotiate (util/deviceProfile.js).
    probeEnv: function () { return probeEnv(window, kind, { engine: xbox ? xbox.engine : null, name: xbox ? xbox.deviceName : 'Beebo TV app' }) },
    backDebounceMs: 0 // >0 only where one Back press can arrive twice (Xbox)
  }
  if (xbox) {
    // Hooks that exist ONLY on Xbox (callers test for them): HLS through hls.js when the web view cannot
    // play HLS itself, the shell's Back / media-remote calls and the Gamepad API fallback, and the state
    // the shell needs to decide whether a B press leaves the app.
    api.backDebounceMs = xbox.backDebounceMs
    api.attachSource = xbox.attachSource
    api.detachSource = xbox.detachSource
    api.installInput = xbox.installInput
    api.noteKey = xbox.noteKey
    api.reportBackState = xbox.reportBackState
  }
  return api
}
