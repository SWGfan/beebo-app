// Reads what this TV / web view can actually play and show, for util/deviceProfile.js. Every call is guarded (a
// missing API is "unknown", never an error) and nothing here runs off a TV: tests pass a fake window.
//
//   Tizen (Samsung)  webapis.productinfo.isUdPanelSupported() -> UHD panel; webapis.avinfo.isHdrTvSupport() -> HDR.
//   webOS (LG)       webOS.deviceInfo(cb) -> { uhd, hdr10, dolbyVision, dolbyAtmos } (webOSTV.js).
//   Xbox / Chromium  matchMedia('(dynamic-range: high)') for HDR, the physical screen size for UHD.
//   everything       video.canPlayType / MediaSource.isTypeSupported for codecs and containers.
//
// UNVERIFIED on real hardware: the names above are from the vendors' documentation, not from a device.

var DEVICE_INFO_TIMEOUT_MS = 1500

function truthy(v) { return v === true || v === 'true' || v === 1 }

function tizenDisplay(win) {
  var d = { uhd: null, hdr10: null, hdr10plus: null, hlg: null, dvProfiles: null, atmos: null }
  try {
    var pi = win.webapis && win.webapis.productinfo
    if (pi && typeof pi.isUdPanelSupported === 'function') d.uhd = !!pi.isUdPanelSupported()
  } catch (e) { /* unknown */ }
  try {
    var av = win.webapis && win.webapis.avinfo
    if (av && typeof av.isHdrTvSupport === 'function') d.hdr10 = !!av.isHdrTvSupport()
  } catch (e2) { /* unknown */ }
  return d
}

function webosDisplay(win) {
  return new Promise(function (resolve) {
    var d = { uhd: null, hdr10: null, hdr10plus: null, hlg: null, dvProfiles: null, atmos: null }
    var done = false
    function finish() { if (!done) { done = true; resolve(d) } }
    try {
      if (!win.webOS || typeof win.webOS.deviceInfo !== 'function') { finish(); return }
      var timer = setTimeout(finish, DEVICE_INFO_TIMEOUT_MS)
      win.webOS.deviceInfo(function (info) {
        clearTimeout(timer)
        try {
          if (info && typeof info === 'object') {
            if ('uhd' in info) d.uhd = truthy(info.uhd)
            if ('hdr10' in info) d.hdr10 = truthy(info.hdr10)
            if (d.hdr10 === true) d.hlg = true // an HDR10 webOS panel also shows HLG
            if ('dolbyVision' in info) d.dvProfiles = truthy(info.dolbyVision) ? [5, 8] : []
            if ('dolbyAtmos' in info) d.atmos = truthy(info.dolbyAtmos)
          }
        } catch (e) { /* keep what we have */ }
        finish()
      })
    } catch (e3) { finish() }
  })
}

function chromiumDisplay(win) {
  var d = { uhd: null, hdr10: null, hdr10plus: null, hlg: null, dvProfiles: null, atmos: null }
  try {
    if (typeof win.matchMedia === 'function') {
      var q = win.matchMedia('(dynamic-range: high)')
      // `matches` false on an engine that does not know the query too: then HDR simply stays off.
      d.hdr10 = !!(q && q.matches)
    }
  } catch (e) { /* unknown */ }
  try {
    var s = win.screen
    var dpr = win.devicePixelRatio || 1
    if (s && s.width && s.height) d.uhd = Math.max(s.width, s.height) * dpr >= 3800
  } catch (e2) { /* unknown */ }
  return d
}

/** -> Promise<{uhd,hdr10,hdr10plus,hlg,dvProfiles,atmos}> (each true / false / null). Never rejects. */
export function readDisplay(win, kind) {
  try {
    if (kind === 'webos') return webosDisplay(win)
    if (kind === 'tizen') return Promise.resolve(tizenDisplay(win))
    return Promise.resolve(chromiumDisplay(win))
  } catch (e) {
    return Promise.resolve({ uhd: null, hdr10: null, hdr10plus: null, hlg: null, dvProfiles: null, atmos: null })
  }
}

/** A `supports(mime)` from a video element and (optionally) MediaSource. */
export function makeSupports(win, video) {
  return function (mime) {
    try {
      if (video && typeof video.canPlayType === 'function' && video.canPlayType(mime) !== '') return true
    } catch (e) { /* fall through */ }
    try {
      var MS = win.MediaSource || win.WebKitMediaSource
      // MediaSource.isTypeSupported is only meaningful for codec-bearing types.
      if (MS && typeof MS.isTypeSupported === 'function' && /codecs=/.test(mime) && MS.isTypeSupported(mime)) return true
    } catch (e2) { /* unknown */ }
    return false
  }
}

/**
 * The env util/deviceProfile.js reads.
 * opts: { engine: function(video) -> 'native' | 'hlsjs' (Xbox only), name: string }
 */
export function probeEnv(win, kind, opts) {
  var o = opts || {}
  var video = null
  try { video = win.document.createElement('video') } catch (e) { video = null }
  var hlsJs = false
  try { hlsJs = typeof o.engine === 'function' && video ? o.engine(video) === 'hlsjs' : false } catch (e2) { hlsJs = false }
  return readDisplay(win, kind).then(function (display) {
    return {
      platform: kind,
      name: o.name || '',
      supports: video ? makeSupports(win, video) : null,
      hlsNative: !!(video && !hlsJs && (function () { try { return !!(video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')) } catch (e) { return false } })()),
      hlsJs: hlsJs,
      display: display
    }
  })
}
