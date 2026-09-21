import test from 'node:test'
import assert from 'node:assert/strict'
import { decideEngine, createSourceAttacher, HLS_CONFIG } from '../app/js/platform/hls.js'
import { createXbox, isXboxHost, hlsModeFromSearch, BACK_DEBOUNCE_MS } from '../app/js/platform/xbox.js'
import { shouldDropBack } from '../app/js/nav/gamepad.js'

// ---- fakes ---------------------------------------------------------------------------------------------------------------

function fakeVideo(canPlay) {
  const listeners = {}
  const events = []
  return {
    canPlayType: (t) => (canPlay && canPlay.indexOf(t) >= 0 ? 'maybe' : ''),
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f) },
    dispatchEvent: (ev) => { events.push(ev.type); (listeners[ev.type] || []).forEach((f) => f(ev)) },
    fire: (n) => (listeners[n] || []).forEach((f) => f({ type: n })),
    events
  }
}

function fakeHls(supported) {
  const instances = []
  function Hls(cfg) {
    this.cfg = cfg
    this.handlers = {}
    this.calls = []
    instances.push(this)
  }
  Hls.isSupported = () => supported
  Hls.Events = { ERROR: 'hlsError' }
  Hls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' }
  Hls.prototype.on = function (n, f) { this.handlers[n] = f }
  Hls.prototype.loadSource = function (u) { this.calls.push('load:' + u) }
  Hls.prototype.attachMedia = function () { this.calls.push('attach') }
  Hls.prototype.startLoad = function () { this.calls.push('startLoad') }
  Hls.prototype.recoverMediaError = function () { this.calls.push('recover') }
  Hls.prototype.destroy = function () { this.calls.push('destroy') }
  Hls.instances = instances
  return Hls
}

function fakeWindow(extra) {
  function FakeEvent(type) { this.type = type }
  return Object.assign({ Event: FakeEvent, location: { search: '' }, navigator: { userAgent: 'x', getGamepads: () => [] } }, extra || {})
}

// ---- engine choice ------------------------------------------------------------------------------------------------

test('decideEngine: native when the video element can play HLS, hls.js when it cannot, native when nothing can', () => {
  const Hls = fakeHls(true)
  assert.equal(decideEngine(fakeVideo(['application/vnd.apple.mpegurl']), Hls, 'auto'), 'native')
  assert.equal(decideEngine(fakeVideo(['application/x-mpegURL']), Hls, 'auto'), 'native')
  assert.equal(decideEngine(fakeVideo([]), Hls, 'auto'), 'hlsjs')
  assert.equal(decideEngine(fakeVideo([]), undefined, 'auto'), 'native') // hls.js not shipped: let the element try
  assert.equal(decideEngine(fakeVideo([]), fakeHls(false), 'auto'), 'native') // MSE unsupported
  assert.equal(decideEngine(null, Hls, 'auto'), 'hlsjs')
})

test('decideEngine: the on-device override wins, but never picks hls.js when it is unusable', () => {
  const Hls = fakeHls(true)
  assert.equal(decideEngine(fakeVideo(['application/vnd.apple.mpegurl']), Hls, 'js'), 'hlsjs')
  assert.equal(decideEngine(fakeVideo([]), Hls, 'native'), 'native')
  assert.equal(decideEngine(fakeVideo([]), undefined, 'js'), 'native')
  assert.equal(decideEngine({ canPlayType() { throw new Error('boom') } }, Hls, 'auto'), 'hlsjs') // a throwing element is "cannot"
  assert.equal(decideEngine(fakeVideo([]), { isSupported() { throw new Error('boom') } }, 'auto'), 'native')
})

test('hlsModeFromSearch: only ?hls=js and ?hls=native count', () => {
  assert.equal(hlsModeFromSearch('?hls=js'), 'js')
  assert.equal(hlsModeFromSearch('?deviceType=Xbox&hls=native'), 'native')
  assert.equal(hlsModeFromSearch('?hls=other'), 'auto')
  assert.equal(hlsModeFromSearch('?xhls=js'), 'auto')
  assert.equal(hlsModeFromSearch(''), 'auto')
  assert.equal(hlsModeFromSearch(undefined), 'auto')
})

// ---- attaching ----------------------------------------------------------------------------------------------------------

test('attach: native engine -> returns false and creates nothing (caller sets video.src)', () => {
  const Hls = fakeHls(true)
  const a = createSourceAttacher(fakeWindow({ Hls }), {})
  assert.equal(a.attach(fakeVideo(['application/vnd.apple.mpegurl']), 'https://h/x.m3u8'), false)
  assert.equal(Hls.instances.length, 0)
})

test('attach: hls.js engine -> configured for a 1 GB app, source loaded, media attached, returns true', () => {
  const Hls = fakeHls(true)
  const a = createSourceAttacher(fakeWindow({ Hls }), {})
  const v = fakeVideo([])
  assert.equal(a.attach(v, 'https://h/hls/t/index.m3u8'), true)
  assert.equal(Hls.instances.length, 1)
  assert.deepEqual(Hls.instances[0].calls, ['load:https://h/hls/t/index.m3u8', 'attach'])
  assert.equal(Hls.instances[0].cfg.enableWorker, false)
  assert.ok(HLS_CONFIG.maxMaxBufferLength <= 60 && HLS_CONFIG.backBufferLength <= 30)
})

test('attach twice (quality change / retry) destroys the first hls.js instance; detach destroys the current one', () => {
  const Hls = fakeHls(true)
  const a = createSourceAttacher(fakeWindow({ Hls }), {})
  const v = fakeVideo([])
  a.attach(v, 'u1')
  a.attach(v, 'u2')
  assert.equal(Hls.instances.length, 2)
  assert.ok(Hls.instances[0].calls.includes('destroy'))
  assert.ok(!Hls.instances[1].calls.includes('destroy'))
  a.detach(v)
  assert.ok(Hls.instances[1].calls.includes('destroy'))
  a.detach(v) // idempotent
})

test('fatal hls.js errors: one network retry, one media recovery, then a plain error event for the player', () => {
  const Hls = fakeHls(true)
  const w = fakeWindow({ Hls })
  let fatals = 0
  const a = createSourceAttacher(w, { onFatal: () => { fatals++ } })
  const v = fakeVideo([])
  a.attach(v, 'u')
  const h = Hls.instances[0].handlers[Hls.Events.ERROR]
  h('e', { fatal: false, type: 'networkError' })
  assert.deepEqual(v.events, []) // non-fatal: ignored
  h('e', { fatal: true, type: 'networkError' })
  assert.ok(Hls.instances[0].calls.includes('startLoad'))
  assert.deepEqual(v.events, [])
  h('e', { fatal: true, type: 'mediaError' })
  assert.ok(Hls.instances[0].calls.includes('recover'))
  assert.deepEqual(v.events, [])
  h('e', { fatal: true, type: 'networkError' }) // second network failure: give up
  assert.deepEqual(v.events, ['error'])
  assert.equal(fatals, 1)
  h('e', { fatal: true, type: 'otherError' })
  assert.deepEqual(v.events, ['error', 'error'])
})

test('errors from a destroyed (replaced) instance are ignored', () => {
  const Hls = fakeHls(true)
  const a = createSourceAttacher(fakeWindow({ Hls }), {})
  const v = fakeVideo([])
  a.attach(v, 'u1')
  const old = Hls.instances[0].handlers[Hls.Events.ERROR]
  a.attach(v, 'u2')
  old('e', { fatal: true, type: 'otherError' })
  assert.deepEqual(v.events, [])
})

// ---- host detection --------------------------------------------------------------------------------------------------------

test('isXboxHost: the shell marker or an Xbox user agent; desktop Edge / Chrome are not Xbox', () => {
  assert.equal(isXboxHost({ __beeboXbox: { deviceForm: 'Xbox Series X' } }), true)
  assert.equal(isXboxHost({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One) AppleWebKit/537.36 Edg/120' } }), true)
  assert.equal(isXboxHost({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36 Edg/120' } }), false)
  assert.equal(isXboxHost({}), false)
  assert.equal(isXboxHost(null), false)
})

test('isXboxHost: ?xbox=1 is the desktop-testing switch, nothing else on the address counts', () => {
  assert.equal(isXboxHost({ location: { search: '?xbox=1' } }), true)
  assert.equal(isXboxHost({ location: { search: '?hls=js&xbox=1' } }), true)
  assert.equal(isXboxHost({ location: { search: '?xbox=10' } }), false)
  assert.equal(isXboxHost({ location: { search: '?notxbox=1' } }), false)
  assert.equal(isXboxHost({ location: { search: '' } }), false)
  assert.equal(isXboxHost({ location: {} }), false)
})

// ---- the Xbox glue ------------------------------------------------------------------------------------------------------------

function hostWindow() {
  const posted = []
  const w = fakeWindow({
    __beeboXbox: { deviceForm: 'Xbox Series S' },
    Hls: fakeHls(true),
    chrome: { webview: { postMessage: (m) => posted.push(JSON.parse(m)) } },
    setInterval: () => 7,
    clearInterval: () => {}
  })
  return { w, posted }
}

test('createXbox: names, device model, and Back debounce', () => {
  const { w } = hostWindow()
  const x = createXbox(w)
  assert.equal(x.deviceName, 'Beebo on Xbox')
  assert.equal(x.deviceModel(), 'xbox Xbox Series S')
  assert.equal(x.backDebounceMs, BACK_DEBOUNCE_MS)
  assert.ok(BACK_DEBOUNCE_MS >= 150 && BACK_DEBOUNCE_MS <= 500)
  assert.equal(createXbox(fakeWindow({ __beeboXbox: {} })).deviceModel(), 'xbox')
})

test('the same B press arriving as a key and as the shell call is one Back (via shouldDropBack)', () => {
  // main.js applies exactly this rule with platform.backDebounceMs
  assert.equal(shouldDropBack(1000, 1040, BACK_DEBOUNCE_MS), true)
  assert.equal(shouldDropBack(1000, 1000 + BACK_DEBOUNCE_MS + 1, BACK_DEBOUNCE_MS), false)
})

test('installInput: the shell can send Back and media-remote buttons; unknown names are ignored', () => {
  const { w } = hostWindow()
  const got = []
  const x = createXbox(w)
  x.installInput((a) => got.push(a))
  w.beeboXbox.back()
  w.beeboXbox.media('playpause')
  w.beeboXbox.media('ff')
  w.beeboXbox.media('previous')
  w.beeboXbox.media('constructor') // must not resolve through the prototype
  w.beeboXbox.media('nonsense')
  assert.deepEqual(got, ['back', 'playpause', 'ff', 'prev'])
})

test('installInput: the Gamepad API fallback works until real gamepad key events show up', () => {
  const { w } = hostWindow()
  let ticks
  w.setInterval = (fn) => { ticks = fn; return 1 }
  let pads = []
  w.navigator.getGamepads = () => pads
  const got = []
  const x = createXbox(w)
  x.installInput((a) => got.push(a))
  const btn = (i) => { const b = []; for (let k = 0; k < 17; k++) b.push({ pressed: k === i, value: k === i ? 1 : 0 }); return { buttons: b, axes: [0, 0] } }
  pads = [btn(0)]
  ticks()
  assert.deepEqual(got, ['enter'])
  x.noteKey({ keyCode: 65 })
  pads = [btn(-1)]
  ticks()
  pads = [btn(0)]
  ticks()
  assert.deepEqual(got, ['enter', 'enter'])
  x.noteKey({ keyCode: 195 }) // GamepadA arrives as a key: the poller must stop
  pads = [btn(-1)]
  ticks()
  pads = [btn(0)]
  ticks()
  assert.deepEqual(got, ['enter', 'enter'])
})

test('reportBackState posts only when the value changes; exit posts once per call', () => {
  const { w, posted } = hostWindow()
  const x = createXbox(w)
  x.reportBackState(false)
  x.reportBackState(false)
  x.reportBackState(true)
  x.reportBackState(1)
  x.reportBackState(0)
  x.exit()
  assert.deepEqual(posted, [
    { type: 'backstate', canGoBack: false },
    { type: 'backstate', canGoBack: true },
    { type: 'backstate', canGoBack: false },
    { type: 'exit' }
  ])
})

test('playback state is mirrored to the shell (keeps the console awake) and hls.js is used when needed', () => {
  const { w, posted } = hostWindow()
  const x = createXbox(w)
  const v = fakeVideo([])
  assert.equal(x.attachSource(v, 'https://h/index.m3u8'), true)
  v.fire('playing')
  v.fire('pause')
  v.fire('ended')
  x.attachSource(v, 'https://h/index2.m3u8') // same element: listeners are not doubled
  v.fire('playing')
  x.detachSource(v)
  assert.deepEqual(posted.map((m) => m.state), ['playing', 'paused', 'stopped', 'playing', 'stopped'])
})

test('with no host (a desktop browser) nothing throws and nothing is posted', () => {
  const x = createXbox({ setInterval: () => 1 })
  x.reportBackState(true)
  x.exit()
  x.noteKey({ keyCode: 195 })
  x.installInput(() => {})
  assert.equal(x.attachSource(fakeVideo([]), 'u'), false) // no hls.js there: the caller sets video.src
  x.detachSource(fakeVideo([]))
})
