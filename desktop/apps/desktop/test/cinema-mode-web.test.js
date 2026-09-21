// The pre-roll controller that runs inside the web player, exercised against a small fake DOM:
// it holds the feature, plays local and YouTube items in turn, always offers Skip, treats every
// server-supplied string as text, refuses ids/urls that are not the expected shape, and lets the
// feature play whenever anything goes wrong. (What needs a real browser / TV: docs/CINEMA-MODE.md.)
// Run: node --test test/cinema-mode-web.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const web = require('../electron/cinemaModeWeb')

// ------------------------------------------------------------------ a tiny fake DOM

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attrs = {}
    this.style = {}
    this.className = ''
    this.id = ''
    this.parentNode = null
    this._text = ''
    this.listeners = {}
    this.paused = false
    this.currentTime = 0
    this.played = 0
    this.pausedCount = 0
  }
  set textContent(v) { this._text = String(v); this.children = [] }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join('') }
  set innerHTML(v) { throw new Error('innerHTML must never be used: ' + v) }
  set outerHTML(v) { throw new Error('outerHTML must never be used') }
  get firstChild() { return this.children[0] || null }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c }
  insertBefore(n, ref) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  removeAttribute(k) { delete this.attrs[k] }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn) }
  fire(type, ev = {}) { for (const fn of this.listeners[type] || []) fn(ev) }
  focus() {}
  pause() { this.paused = true; this.pausedCount++ }
  play() { this.paused = false; this.played++; return Promise.resolve() }
  load() {}
  click() { if (this.onclick) this.onclick({ preventDefault() {}, stopPropagation() {} }) }
  find(pred) {
    if (pred(this)) return this
    for (const c of this.children) { const r = c.find(pred); if (r) return r }
    return null
  }
  findAll(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.findAll(pred, out); return out }
}

function harness({ search = '', hint = false, items = null, response = null, fail = false, online = true, yt = true, hasResumePrompt = false, delayMs = 0, readyState = 'complete' } = {}) {
  let resumePrompt = hasResumePrompt
  const created = []
  const body = new El('body')
  const head = new El('head')
  const video = new El('video')
  video.id = 'v'
  video.attrs.autoplay = ''
  const bar = new El('div')
  const cast = new El('button')
  cast.id = 'castBtn'
  bar.appendChild(cast)
  body.appendChild(bar)
  body.appendChild(video)
  const docListeners = {}
  const document = {
    body, head, readyState,
    getElementById(id) {
      if (id === 'resumeprompt') return resumePrompt ? new El('div') : null
      return body.find((e) => e.id === id) || head.find((e) => e.id === id)
    },
    createElement(tag) { const e = new El(tag); created.push(e); return e },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn) },
    removeEventListener(type, fn) { docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn) }
  }
  const requests = []
  const store = { 'beebo:cinema': hint ? '1' : null }
  const timers = []
  const players = []
  const win = {}
  win.fetch = (url, opts) => {
    requests.push({ url, opts })
    if (fail) return Promise.reject(new Error('network'))
    const res = url.includes('/playback/preroll?')
      ? (response || { ok: true, enabled: true, wants: true, maxTrailerSeconds: 240, tmdbAttribution: 'TMDB credit line.', items: items || [] })
      : { ok: true, prefs: { enabled: true, count: 2, useIntro: true, sources: {}, dedupeDays: 30 }, available: true, onlineAllowed: true }
    const respond = () => ({ json: () => Promise.resolve(res) })
    return delayMs ? new Promise((r) => timers.push({ fn: () => r(respond()), ms: delayMs, id: -1 })) : Promise.resolve(respond())
  }
  if (yt) {
    win.YT = {
      Player: class { constructor(el, cfg) { this.el = el; this.cfg = cfg; this.destroyed = false; players.push(this) } playVideo() { this.played = true } destroy() { this.destroyed = true } }
    }
  }
  let nextTimer = 1
  const sandbox = {
    document, window: win, requests, JSON, URLSearchParams, Promise, Error, Number, String, Math, encodeURIComponent, Array, Object,
    location: { search, origin: 'http://192.168.1.5:47811' },
    navigator: { onLine: online },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v } },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.push({ fn, ms, id }); return id },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1) }
  }
  sandbox.window.fetch = win.fetch
  sandbox.fetch = win.fetch
  const cfg = { kind: 'movie', id: 'RmVhdHVyZQ', api: '/playback-api' }
  vm.runInNewContext(`(${web.clientMain.toString()})(${JSON.stringify(cfg)})`, sandbox)
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  return {
    body, head, video, document, requests, store, timers, players, created, win, flush,
    layer: () => body.find((e) => e.id === 'cmLayer'),
    stage: () => body.find((e) => e.id === 'cmStage'),
    byId: (id) => body.find((e) => e.id === id),
    key: (k) => { const ev = { key: k, preventDefault() {} }; for (const fn of docListeners.keydown || []) fn(ev) },
    fireTimer: (predicate) => { const t = timers.find(predicate); if (t) { timers.splice(timers.indexOf(t), 1); t.fn() } },
    posts: () => requests.filter((r) => r.opts && r.opts.method === 'POST').map((r) => ({ url: r.url, body: JSON.parse(r.opts.body) })),
    docListeners,
    setResumePrompt: (on) => { resumePrompt = on },
    domReady: () => { for (const fn of docListeners.DOMContentLoaded || []) fn({}) }
  }
}

const YT_ID = 'AbCdEfGhI01'
const LOCAL = (n) => `/cinema/media/${String(n).repeat(20).slice(0, 20).replace(/[^a-f0-9]/g, 'a')}?mt=1234567890.AbCdEfGhIjKlMnOpQrStUvWxYz`
const intro = { type: 'local', role: 'intro', url: LOCAL('a'), title: 'Feature Presentation', durationSec: 5, attribution: 'Your own intro clip.', key: 'i:abc' }
const localTrailer = { type: 'local', role: 'trailer', url: LOCAL('b'), title: 'Local Trailer', durationSec: 60, attribution: 'A video file on this computer.', key: 'l:bbb', titleKey: 't:m5' }
const ytTrailer = { type: 'youtube', role: 'trailer', videoId: YT_ID, title: 'Online Trailer', durationSec: null, attribution: "Trailer from YouTube, played in YouTube's embedded player.", key: 'y:' + YT_ID, titleKey: 't:m6' }

// ------------------------------------------------------------------ tests

test('the controller source uses no HTML injection, eval or document.write', () => {
  const src = web.clientMain.toString()
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.write']) assert.ok(!src.includes(bad), bad)
  const html = web.cinemaHtml({ kind: 'movie', mediaId: 'x' })
  assert.equal((html.match(/<\/script/gi) || []).length, 1, 'exactly one closing script tag')
})

test('cinemaHtml: nothing for shows or without an id; the id is JSON-escaped', () => {
  assert.equal(web.cinemaHtml({ kind: 'tv', mediaId: 'x' }), '')
  assert.equal(web.cinemaHtml({ kind: 'movie', mediaId: '' }), '')
  const html = web.cinemaHtml({ kind: 'movie', mediaId: '"></script><script>alert(1)</script>' })
  assert.ok(!/<script>alert/.test(html), 'a hostile id cannot open a new script')
  assert.equal((html.match(/<\/script/gi) || []).length, 1)
})

test('with Cinema Mode off the feature is left alone', async () => {
  const h = harness({ response: { ok: true, enabled: false, reason: 'disabled', items: [] } })
  await h.flush()
  assert.equal(h.layer(), null)
  assert.equal(h.video.pausedCount, 0, 'never paused')
  assert.equal(h.video.played, 0, 'never restarted')
  assert.ok(h.requests.some((r) => /\/playback-api\/playback\/preroll\?kind=movie&id=RmVhdHVyZQ/.test(r.url)))
})

test('plays intro then trailers on a black layer, holds the feature, reports only trailers, then releases the feature', async () => {
  const h = harness({ items: [intro, localTrailer, ytTrailer] })
  await h.flush()
  assert.ok(h.layer(), 'the pre-show layer is up')
  assert.equal(h.video.paused, true, 'the feature is held')
  assert.equal(h.video.getAttribute('autoplay'), null)
  assert.equal(h.byId('cmSkip').textContent, 'Skip', 'Skip is on screen')
  assert.ok(h.byId('cmSkipAll'))
  assert.equal(h.byId('cmTitle').textContent, 'Feature Presentation')
  assert.match(h.byId('cmHead').textContent, /Feature presentation/i)
  let vid = h.stage().find((e) => e.tagName === 'VIDEO')
  assert.equal(vid.src, intro.url)
  vid.fire('ended') // intro done
  assert.equal(h.byId('cmTitle').textContent, 'Local Trailer')
  assert.match(h.byId('cmHead').textContent, /Coming attractions - 1 of 2/)
  vid = h.stage().find((e) => e.tagName === 'VIDEO')
  assert.equal(vid.src, localTrailer.url)
  vid.fire('playing')
  vid.fire('ended')
  assert.equal(h.byId('cmTitle').textContent, 'Online Trailer')
  assert.match(h.byId('cmAttr').textContent, /YouTube/)
  assert.match(h.byId('cmAttr').textContent, /TMDB credit line/, 'TMDB attribution shows with an online trailer')
  await h.flush()
  const frame = h.stage().find((e) => e.tagName === 'IFRAME')
  assert.ok(frame, 'a YouTube item plays in an iframe')
  assert.equal(h.players.length, 1)
  h.players[0].cfg.events.onStateChange({ data: 1 })
  h.players[0].cfg.events.onStateChange({ data: 0 })
  assert.equal(h.layer(), null, 'the layer is gone after the last item')
  assert.ok(h.video.played >= 1, 'the feature starts')
  assert.equal(h.players[0].destroyed, true, 'the YouTube player is destroyed')
  const posts = h.posts().filter((p) => p.url.endsWith('/preroll/seen'))
  assert.deepEqual(posts.map((p) => p.body.items[0].key).sort(), ['l:bbb', 'y:' + YT_ID], 'the intro is not reported')
  assert.equal(posts.find((p) => p.body.items[0].key === 'l:bbb').body.items[0].titleKey, 't:m5')
})

test('YouTube items use ONLY the privacy-enhanced embed with the official IFrame API, an exact id, and never a cover-up overlay', async () => {
  const h = harness({ items: [ytTrailer] })
  await h.flush()
  const frame = h.stage().find((e) => e.tagName === 'IFRAME')
  assert.match(frame.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/AbCdEfGhI01\?enablejsapi=1&autoplay=1&playsinline=1&rel=0&origin=/)
  assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin')
  assert.match(frame.getAttribute('allow'), /autoplay/)
  assert.equal(h.players[0].el, frame, 'the official API attaches to that iframe')
  const bar = h.byId('cmBar')
  assert.equal(h.stage().find((e) => e.id === 'cmSkip'), null, 'the Skip button is not inside (on top of) the player area')
  assert.ok(bar.find((e) => e.id === 'cmSkip'), 'it sits in its own bar beside it')
  assert.equal(h.stage().findAll((e) => e.tagName === 'A' || e.tagName === 'SCRIPT').length, 0)
  const scripts = h.head.findAll((e) => e.tagName === 'SCRIPT')
  assert.equal(scripts.length, 0, 'the API was already present, so no script was added')
})

test('the YouTube IFrame API script is only ever loaded from youtube.com', async () => {
  const h = harness({ items: [ytTrailer], yt: false })
  await h.flush()
  const scripts = h.head.findAll((e) => e.tagName === 'SCRIPT')
  assert.equal(scripts.length, 1)
  assert.equal(scripts[0].src, 'https://www.youtube.com/iframe_api')
  // the API arrives
  h.win.YT = { Player: class { constructor(el, cfg) { h.players.push(this); this.cfg = cfg } playVideo() {} destroy() {} } }
  h.win.onYouTubeIframeAPIReady()
  await h.flush()
  assert.equal(h.players.length, 1)
})

test('offline, a blocked/slow YouTube, or an embed error skips the trailer and the feature plays', async () => {
  const off = harness({ items: [ytTrailer], online: false })
  await off.flush()
  assert.equal(off.layer(), null, 'offline: skipped at once')
  assert.ok(off.video.played >= 1)
  assert.equal(off.stage(), null)

  const blocked = harness({ items: [ytTrailer], yt: false })
  await blocked.flush()
  blocked.head.find((e) => e.tagName === 'SCRIPT').onerror()
  await blocked.flush()
  assert.equal(blocked.layer(), null, 'the API script could not load')
  assert.ok(blocked.video.played >= 1)

  const err = harness({ items: [ytTrailer, localTrailer] })
  await err.flush()
  err.players[0].cfg.events.onError({ data: 150 }) // embedding disabled by the owner of the video
  assert.equal(err.byId('cmTitle').textContent, 'Local Trailer', 'moved on to the next item')

  const stuck = harness({ items: [ytTrailer] })
  await stuck.flush()
  stuck.fireTimer((t) => t.ms === 15000) // never started (autoplay refused)
  assert.equal(stuck.layer(), null)
})

test('Skip moves to the next item; Skip all, Escape and the last item release the feature', async () => {
  const h = harness({ items: [localTrailer, { ...localTrailer, title: 'Second', key: 'l:ccc', url: LOCAL('c') }, { ...localTrailer, title: 'Third', key: 'l:ddd', url: LOCAL('d') }] })
  await h.flush()
  assert.equal(h.byId('cmTitle').textContent, 'Local Trailer')
  h.byId('cmSkip').click()
  assert.equal(h.byId('cmTitle').textContent, 'Second')
  h.key('ArrowRight')
  assert.equal(h.byId('cmTitle').textContent, 'Third')
  h.byId('cmSkipAll').click()
  assert.equal(h.layer(), null)
  assert.ok(h.video.played >= 1)
  assert.equal((h.docListeners.keydown || []).length, 0, 'the key handler is removed')
  const h2 = harness({ items: [localTrailer] })
  await h2.flush()
  h2.key('Escape')
  assert.equal(h2.layer(), null)
  assert.ok(h2.video.played >= 1)
  assert.equal(h2.posts().length, 0, 'a skipped item that never started is not recorded as seen')
})

test('a video that will not load or errors is skipped', async () => {
  const h = harness({ items: [localTrailer, { ...localTrailer, title: 'Second', key: 'l:ccc', url: LOCAL('c') }] })
  await h.flush()
  h.stage().find((e) => e.tagName === 'VIDEO').fire('error')
  assert.equal(h.byId('cmTitle').textContent, 'Second')
  h.fireTimer((t) => t.ms === 15000) // metadata never arrived
  assert.equal(h.layer(), null)
})

test('a trailer that runs far too long is cut off', async () => {
  const h = harness({ items: [localTrailer] })
  await h.flush()
  const cutoff = h.timers.find((t) => t.ms > 240000)
  assert.ok(cutoff, 'there is a maximum-length timer')
  h.fireTimer((t) => t === cutoff)
  assert.equal(h.layer(), null)
})

test('XSS: titles and attributions from the server are text, never markup', async () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\''
  const h = harness({ items: [{ ...localTrailer, title: evil, attribution: evil }] })
  await h.flush()
  assert.equal(h.byId('cmTitle').textContent, evil)
  assert.equal(h.byId('cmAttr').textContent, evil)
  assert.equal(h.created.filter((e) => ['IMG', 'SCRIPT', 'A'].includes(e.tagName)).length, 0, 'no element was created from the text')
  const yt = harness({ items: [{ ...ytTrailer, title: evil }] })
  await yt.flush()
  const frame = yt.stage().find((e) => e.tagName === 'IFRAME')
  assert.equal(frame.title, 'Trailer: ' + evil)
  assert.ok(!frame.src.includes('<'))
})

test('id and url validation: anything that is not exactly the expected shape is dropped', async () => {
  const bad = [
    { type: 'youtube', role: 'trailer', videoId: 'short', title: 'a', key: 'y:short' },
    { type: 'youtube', role: 'trailer', videoId: 'AbCdEfGhI01/../x', title: 'b', key: 'y:b' },
    { type: 'youtube', role: 'trailer', videoId: '"><script>x</script>', title: 'c', key: 'y:c' },
    { type: 'youtube', role: 'trailer', videoId: 'AbCdEfGhI01A', title: 'twelve chars', key: 'y:d' },
    { type: 'youtube', role: 'trailer', title: 'no id', key: 'y:e' },
    { type: 'local', role: 'trailer', url: 'https://evil.example/x.mp4', title: 'd', key: 'l:d' },
    { type: 'local', role: 'trailer', url: '//evil.example/x.mp4', title: 'e', key: 'l:e' },
    { type: 'local', role: 'trailer', url: 'javascript:alert(1)', title: 'f', key: 'l:f' },
    { type: 'local', role: 'trailer', url: '/cinema/media/../../etc/passwd?mt=1234567890', title: 'g', key: 'l:g' },
    { type: 'local', role: 'trailer', url: '/api/admin/users', title: 'h', key: 'l:h' },
    { type: 'local', role: 'trailer', url: LOCAL('a') + '&x=<script>', title: 'i', key: 'l:i' },
    { type: 'script', role: 'trailer', url: LOCAL('a'), title: 'j', key: 'l:j' },
    null, 'x', 42
  ]
  const h = harness({ items: bad })
  await h.flush()
  assert.equal(h.layer(), null, 'nothing valid: no pre-show at all')
  assert.ok(h.video.played === 0 && h.video.pausedCount === 0, 'the feature was never touched')
  const mixed = harness({ items: [...bad, localTrailer] })
  await mixed.flush()
  assert.equal(mixed.byId('cmTitle').textContent, 'Local Trailer', 'the one valid item still plays')
})

test('an unreadable seen-key is never sent (only well-formed keys are reported)', async () => {
  const h = harness({ items: [{ ...localTrailer, key: '<b>', titleKey: 'nope' }] })
  await h.flush()
  const vid = h.stage().find((e) => e.tagName === 'VIDEO')
  vid.fire('playing')
  assert.equal(h.posts().length, 0)
})

test('fail open: a network error, a bad answer or a slow server never keeps the feature from playing', async () => {
  const failed = harness({ fail: true, hint: true })
  await failed.flush()
  assert.equal(failed.layer(), null)
  assert.ok(failed.video.played >= 1, 'held by the hint, then released')
  const junk = harness({ response: { ok: false }, hint: true })
  await junk.flush()
  assert.ok(junk.video.played >= 1)
  const slow = harness({ hint: true, delayMs: 60000, items: [localTrailer] })
  await slow.flush()
  assert.equal(slow.video.paused, true, 'held while waiting')
  slow.fireTimer((t) => t.ms === 9000)
  assert.ok(slow.video.played >= 1, 'released after 9 seconds')
  slow.fireTimer((t) => t.id === -1) // the answer arrives too late
  await slow.flush()
  assert.equal(slow.layer(), null, 'a late answer does not start a pre-show in the middle of the feature')
})

test('which plays ask: ?preshow=0 never asks; resuming never asks; ?preshow=1 always holds and asks', async () => {
  const no = harness({ search: '?id=x&preshow=0', hint: true, items: [localTrailer] })
  await no.flush()
  assert.equal(no.requests.length, 0)
  assert.equal(no.video.pausedCount, 0)
  const resume = harness({ search: '?id=x&t=300', hint: true, items: [localTrailer] })
  await resume.flush()
  assert.equal(resume.requests.length, 0)
  const prompt = harness({ hasResumePrompt: true, hint: true, items: [localTrailer] })
  await prompt.flush()
  assert.equal(prompt.requests.length, 0, 'an unanswered "Resume?" prompt means resuming')
  const asked = harness({ search: '?id=x&t=300&preshow=1', items: [localTrailer] })
  assert.equal(asked.video.paused, true, 'held at once, before the answer arrives')
  await asked.flush()
  assert.match(asked.requests[0].url, /preshow=1/)
  assert.ok(asked.layer())
  const plain = harness({ items: [localTrailer] })
  assert.equal(plain.video.paused, false, 'without a hint or a request, nothing is held while the answer is fetched')
  await plain.flush()
})

test('the remembered hint follows the server: turning it on/off elsewhere is picked up', async () => {
  const off = harness({ hint: true, response: { ok: true, enabled: false, wants: false, items: [] } })
  await off.flush()
  assert.equal(off.store['beebo:cinema'], '0')
  const on = harness({ hint: false, response: { ok: true, enabled: false, wants: true, reason: 'once_per_night', items: [] } })
  await on.flush()
  assert.equal(on.store['beebo:cinema'], '1')
})

test('"Don\'t show trailers" tells the server, remembers it here and releases the feature', async () => {
  const h = harness({ items: [localTrailer] })
  await h.flush()
  h.byId('cmNever').click()
  assert.equal(h.layer(), null)
  assert.equal(h.store['beebo:cinema'], '0')
  const post = h.posts().find((p) => p.url.endsWith('/playback/cinema'))
  assert.deepEqual(post.body, { neverShow: true })
  assert.ok(h.video.played >= 1)
})

test('the settings sheet is built from text nodes and saves through the person\'s own endpoint', async () => {
  const h = harness({ response: { ok: true, enabled: false, items: [] } })
  await h.flush()
  const btn = h.byId('cmBtn')
  assert.ok(btn, 'a Pre-show button sits in the top bar')
  assert.equal(btn.parentNode.children.indexOf(btn) < btn.parentNode.children.indexOf(h.byId('castBtn')), true)
  btn.click()
  await h.flush()
  const sheet = h.byId('cmSheet')
  assert.equal(sheet.className, 'open')
  const boxes = sheet.findAll((e) => e.tagName === 'INPUT')
  assert.ok(boxes.length >= 5, 'toggles for every choice')
  boxes[0].checked = true
  boxes[0].onchange()
  await h.flush()
  assert.deepEqual(h.posts().find((p) => p.url.endsWith('/playback/cinema')).body, { enabled: true })
  assert.equal(h.store['beebo:cinema'], '1')
})

test('the Resume prompt further down the page is seen: the page is asked only once it is parsed, and a resumed film gets no pre-show', async () => {
  const h = harness({ hint: true, readyState: 'loading', items: [localTrailer] })
  assert.equal(h.video.paused, true, 'held at once because Cinema Mode is on')
  assert.equal(h.requests.length, 0, 'nothing is asked while the page is still being parsed')
  h.setResumePrompt(true) // the prompt appears later in the page
  h.domReady()
  await h.flush()
  assert.equal(h.requests.length, 0, 'resuming: no pre-show')
  assert.equal(h.layer(), null)
  assert.ok(h.video.played >= 1, 'the hold is lifted')
  const normal = harness({ hint: true, readyState: 'loading', items: [localTrailer] })
  normal.domReady()
  await normal.flush()
  assert.ok(normal.layer(), 'a fresh play still gets its pre-show')
  const explicit = harness({ search: '?id=x&preshow=1', readyState: 'loading', items: [localTrailer] })
  explicit.setResumePrompt(true)
  explicit.domReady()
  await explicit.flush()
  assert.ok(explicit.layer(), 'an explicit request still plays even when resuming')
})
