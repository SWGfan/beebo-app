// HLS source attachment for engines whose <video> cannot play an .m3u8 by itself.
//
// Samsung Tizen and LG webOS play HLS natively, so those builds never load hls.js and never call this
// (platform.attachSource is simply absent). Xbox hosts the app in a WebView2 (Chromium) control. Recent
// Chromium plays HLS natively, older builds do not, and which one an Xbox has is unknown until it is
// tried (see docs/XBOX.md), so the Xbox build ships hls.js (Apache-2.0, media-source based, plays the
// same H.264/AAC HLS the server already produces) and decides AT RUNTIME:
//
//   'native'  the <video> element says it can play HLS, or hls.js is not loaded  -> caller sets video.src
//   'hlsjs'   otherwise, and hls.js is loaded and supported                       -> hls.js owns the stream
//
// The decision is a pure function (unit-tested with fakes). mode 'js' / 'native' force a side for
// on-device testing (start the app with ?hls=js or ?hls=native, see README).

/** @returns {'native'|'hlsjs'} */
export function decideEngine(video, Hls, mode) {
  var hlsOk = false
  try { hlsOk = !!(Hls && typeof Hls === 'function' && Hls.isSupported && Hls.isSupported()) } catch (e) { hlsOk = false }
  if (mode === 'native') return 'native'
  if (mode === 'js') return hlsOk ? 'hlsjs' : 'native'
  var canNative = false
  try {
    canNative = !!(video && typeof video.canPlayType === 'function' &&
      (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')))
  } catch (e) { canNative = false }
  if (canNative) return 'native'
  return hlsOk ? 'hlsjs' : 'native'
}

// Small buffers: an Xbox app gets about 1 GB (Microsoft Learn, "System resources for UWP apps and games
// on Xbox One"), and the web view shares it with the page.
export var HLS_CONFIG = {
  enableWorker: false, // the page's CSP has no worker-src; hls.js falls back to the main thread
  lowLatencyMode: false,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  backBufferLength: 20,
  startFragPrefetch: false
}

/**
 * @param {*} win   the window (reads win.Hls)
 * @param {{mode?:string, onFatal?:function}} opts
 * @returns {{attach:function(*,string):boolean, detach:function(*):void, engine:function(*):string}}
 */
export function createSourceAttacher(win, opts) {
  var o = opts || {}
  var instance = null

  function detach(video) {
    if (instance) {
      var i = instance
      instance = null
      try { i.destroy() } catch (e) { /* ignore */ }
    }
    return video
  }

  function fatal(video) {
    // hls.js failures do not set video.error; turn them into the plain 'error' event the player already handles.
    try {
      var ev
      if (typeof win.Event === 'function') ev = new win.Event('error')
      else { ev = win.document.createEvent('Event'); ev.initEvent('error', false, false) }
      video.dispatchEvent(ev)
    } catch (e) { /* ignore */ }
    if (typeof o.onFatal === 'function') { try { o.onFatal() } catch (e2) { /* ignore */ } }
  }

  return {
    engine: function (video) { return decideEngine(video, win.Hls, o.mode || 'auto') },

    /** true: hls.js is playing `url` into `video` (do not set video.src). false: set video.src yourself. */
    attach: function (video, url) {
      detach(video)
      if (decideEngine(video, win.Hls, o.mode || 'auto') !== 'hlsjs') return false
      var Hls = win.Hls
      var hls = new Hls(HLS_CONFIG)
      instance = hls
      var triedNet = false
      var triedMedia = false
      hls.on(Hls.Events.ERROR, function (evName, data) {
        if (!data || !data.fatal || hls !== instance) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !triedNet) { triedNet = true; try { hls.startLoad() } catch (e) { fatal(video) } return }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !triedMedia) { triedMedia = true; try { hls.recoverMediaError() } catch (e) { fatal(video) } return }
        fatal(video)
      })
      hls.loadSource(url)
      hls.attachMedia(video)
      return true
    },

    detach: detach
  }
}
