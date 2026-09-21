// The web player's seek strip (chapters + preview pictures), chapter menu/keys and subtitle styling,
// run for real against a tiny fake browser (no DOM library): what it asks the PC for, what it puts on
// the page, what it saves, and that untrusted chapter titles never become markup.
// Run: node --test test/playback-web-player.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { playbackPanelHtml } = localRequire('./electron/playbackWebUi')

class El {
  constructor(tag, made) {
    this.tagName = tag
    this.children = []
    this.style = {}
    this._html = ''
    this.attrs = {}
    this.listeners = {}
    this.textContent = ''
    this.className = ''
    this.classes = new Set()
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c) }
    made.push(this)
  }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c }
  insertBefore(c) { this.children.push(c); c.parentNode = this; return c }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = [] }
  get innerHTML() { return this._html }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  removeAttribute(k) { delete this.attrs[k] }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f) }
  removeEventListener() {}
  remove() {}
  focus() {}
  scrollIntoView() { this.scrolled = true }
  querySelector() { return null }
  getBoundingClientRect() { return { left: 100, width: 1000, top: 0, height: 24 } }
  setPointerCapture() {}
  fire(type, extra = {}) { for (const f of this.listeners[type] || []) f({ target: this, preventDefault() {}, ...extra }) }
}
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)) }
const all = (root, pred, out = []) => { if (pred(root)) out.push(root); for (const c of root.children) all(c, pred, out); return out }

const CHAPTERS = [
  { index: 0, startSec: 0, endSec: 600, title: 'Opening' },
  { index: 1, startSec: 600, endSec: 1200, title: 'Middle <img src=x onerror=alert(1)>' },
  { index: 2, startSec: 1200, endSec: 1800, title: '' }
]
const STYLE = { size: 100, color: '#FFFFFF', bg: '#000000', bgOpacity: 0, edge: 'shadow', position: 8, font: 'default' }
const INFO = {
  ok: true, kind: 'movie', id: 'abc', durationSec: 1800, bitrateKbps: 8000,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 24, hdr: false },
  original: { label: 'Original · 1080p', height: 1080 },
  direct: { android: true, browser: true },
  qualities: [{ id: '720p', label: '720p', videoKbps: 4000, upscale: false }],
  transcode: { available: true, encoder: 'libx264' },
  audio: [], audioOptions: {}, subtitles: [{ key: 'emb:2', source: 'embedded', kind: 'text', label: 'English', language: 'eng', streamIndex: 2, url: '/subtitles/embedded?x=1' }],
  onlineSearch: { configured: false }, chapters: CHAPTERS,
  prefs: { quality: 'original', audioLanguage: '', subtitleLanguage: '', subtitlesOn: false, audioMode: 'auto', downmix: 'standard', night: false, normalize: false, boostDb: 0, audioDelayMs: 0, subtitleStyle: { ...STYLE } }
}
const TP = { ok: true, available: true, generating: false, intervalSec: 10, count: 181, width: 160, thumbUrl: '/trickplay/thumb?kind=movie&id=abc&mt=1.2' }

async function boot({ info = INFO, trickplay = [TP], search = '' } = {}) {
  const js = playbackPanelHtml({ kind: 'movie', mediaId: 'abc' }).split('<script>')[1].split('</script>')[0]
  const made = []
  const byId = {}
  const el = (id, tag = 'div') => { if (!byId[id]) { const e = new El(tag, made); e.id = id; byId[id] = e } return byId[id] }
  const video = el('v', 'video')
  Object.assign(video, { currentTime: 0, paused: false, duration: 1800, clientHeight: 720, canPlayType: () => '', play: () => Promise.resolve() })
  video.attrs.src = '/file/original.mp4'
  const cast = el('castBtn', 'button')
  cast.parentNode = { insertBefore: (c) => c }
  const calls = []
  const respond = (body) => Promise.resolve({ json: () => Promise.resolve(body), arrayBuffer: () => Promise.resolve(new ArrayBuffer(2 * 1024 * 1024)) })
  let tpCall = 0
  let prefsState = { ...info.prefs }
  const fetchStub = (url, opts) => {
    const u = String(url)
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body })
    if (u.includes('/playback/info')) return respond({ ...info, prefs: prefsState })
    if (u.includes('/playback/trickplay/info')) return respond(trickplay[Math.min(tpCall++, trickplay.length - 1)])
    if (u.includes('/playback/prefs')) return respond({ ok: true, prefs: prefsState })
    return respond({ ok: true })
  }
  const timers = []
  const docListeners = {}
  const documentObj = {
    getElementById: (id) => el(id),
    createElement: (tag) => new El(tag, made),
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f) },
    body: new El('body', made), head: new El('head', made)
  }
  const toasts = []
  const sandbox = {
    document: documentObj, fetch: fetchStub, performance: { now: () => Date.now() }, navigator: {}, Blob: class {},
    Hls: class { static isSupported() { return true } },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length },
    clearTimeout: () => {},
    toast: (m) => toasts.push(m),
    poke: () => {},
    location: { search, href: '' }
  }
  sandbox.window = sandbox
  sandbox.addEventListener = () => {}
  vm.runInNewContext(js, sandbox)
  await flush()
  const ui = {
    calls, made, video, byId, location: sandbox.location, timers, toasts, docListeners, documentObj,
    prefPosts: () => calls.filter((c) => c.url.includes('/playback/prefs') && c.method === 'POST'),
    tpCalls: () => calls.filter((c) => c.url.includes('/playback/trickplay/info')),
    key: (key, extra = {}) => { for (const f of docListeners.keydown || []) f({ key, target: { tagName: 'body' }, preventDefault() {}, ...extra }) },
    strip: () => made.find((e) => e.id === 'pbTl') || null,
    track: () => made.find((e) => e.className === 'pb-track') || null,
    img: () => made.find((e) => e.tagName === 'img') || null,
    cueRule: () => { const s = made.filter((e) => e.tagName === 'style' && /::cue/.test(e.textContent)); return s.length ? s[s.length - 1].textContent : '' },
    open: async () => { made.find((e) => e.id === 'pbBtn').onclick(); await flush() },
    prev: () => [...made].reverse().find((e) => e.id === 'pbPrevText'),
    body: () => byId.pbBody,
    prefs: () => prefsState
  }
  return ui
}

test('no chapters and no previews: no strip and no chapter button (the browser bar is all there is)', async () => {
  const ui = await boot({ info: { ...INFO, chapters: [] }, trickplay: [{ ok: true, available: false, generating: false }] })
  assert.equal(ui.strip(), null)
  assert.equal(ui.byId.pbChapBtn, undefined)
  assert.equal(ui.made.find((e) => e.id === 'pbChapBtn'), undefined)
})

test('an old server (no chapters field, no trickplay route answer, no subtitleStyle) still works', async () => {
  const noStyle = { ...INFO.prefs }
  delete noStyle.subtitleStyle
  const info = { ...INFO, prefs: noStyle }
  delete info.chapters
  const ui = await boot({ info, trickplay: [{ ok: false }] })
  assert.equal(ui.strip(), null)
  assert.match(ui.cueRule(), /^#v::cue\{color:#FFFFFF;/)
  await ui.open()
  assert.ok(ui.prev(), 'the live preview is there')
})

test('chapters: strip shows, ticks skip the very start, current chapter is named, title is text not markup', async () => {
  const ui = await boot({ trickplay: [{ ok: true, available: false }] })
  const strip = ui.strip()
  assert.ok(strip, 'strip built for a film with chapters')
  assert.equal(strip.style.display, 'block')
  const ticks = all(strip, (e) => e.tagName === 'i')
  assert.equal(ticks.length, 2)
  assert.equal(ticks[0].style.left, '33.33333333333333%')
  ui.video.currentTime = 700
  ui.video.fire('timeupdate')
  const chapLabel = all(strip, (e) => e.className === 'pb-tlchap')[0]
  assert.equal(chapLabel.textContent, '2/3 · Middle <img src=x onerror=alert(1)>', 'set as textContent, so the browser shows it literally')
  assert.equal(chapLabel._html, '', 'never innerHTML')
  const track = ui.track()
  assert.equal(track.attrs['aria-valuetext'], '11:40 · Middle <img src=x onerror=alert(1)>')
  ui.video.currentTime = 1500
  ui.video.fire('timeupdate')
  assert.equal(chapLabel.textContent, '3/3 · Chapter 3', 'an untitled chapter gets its number')
})

test('chapter menu: a Chapters button appears, the list escapes titles and seeks on click', async () => {
  const ui = await boot({ trickplay: [{ ok: true, available: false }] })
  const btn = ui.made.find((e) => e.id === 'pbChapBtn')
  assert.ok(btn, 'top-bar button')
  btn.onclick()
  await flush()
  assert.equal(ui.byId.pbSheet.classes.has('open'), true)
  const rows = ui.body().children.filter((c) => c.tagName === 'button' && /\d\. /.test(c._html))
  assert.equal(rows.length, 3)
  assert.match(rows[1]._html, /2\. Middle &lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(rows[1]._html, /<img/)
  assert.match(rows[1]._html, /10:00/)
  rows[1].onclick()
  assert.equal(ui.video.currentTime, 600)
  assert.equal(ui.byId.pbSheet.classes.has('open'), false, 'the menu closes after a pick')
  const head = ui.body().children.find((c) => c.tagName === 'h3' && c.textContent === 'Chapters')
  assert.ok(head)
})

test('chapter keys: ] and PageDown go forward, [ and PageUp restart then go back, typing in a box is left alone', async () => {
  const ui = await boot({ trickplay: [{ ok: true, available: false }] })
  ui.video.currentTime = 100
  ui.key(']')
  assert.equal(ui.video.currentTime, 600)
  assert.match(ui.toasts[ui.toasts.length - 1], /^2\/3 · Middle/)
  ui.video.currentTime = 650
  ui.key('[')
  assert.equal(ui.video.currentTime, 600, 'more than 3 s in: restart this chapter')
  ui.key('PageUp')
  assert.equal(ui.video.currentTime, 0, 'within 3 s of the start: the previous chapter')
  ui.key('PageDown')
  assert.equal(ui.video.currentTime, 600)
  ui.video.currentTime = 1700
  ui.key(']')
  assert.equal(ui.video.currentTime, 1700, 'no next chapter: stays')
  ui.video.currentTime = 100
  ui.key(']', { target: { tagName: 'INPUT' } })
  assert.equal(ui.video.currentTime, 100, 'ignored inside an input')
  ui.key(']', { ctrlKey: true })
  assert.equal(ui.video.currentTime, 100, 'ignored with Ctrl')
})

test('previews: hovering shows the nearest picture (quantised, clamped) and the time; leaving hides it', async () => {
  const ui = await boot({ info: { ...INFO, chapters: [] } })
  const strip = ui.strip()
  assert.ok(strip, 'a finished preview set alone is enough for the strip')
  const track = ui.track()
  // track: left 100, width 1000, duration 1800 -> x=600 is half way = 900 s.
  track.fire('pointermove', { clientX: 600 })
  assert.equal(ui.img().attrs.src, '/trickplay/thumb?kind=movie&id=abc&mt=1.2&t=900')
  track.fire('pointermove', { clientX: 100 + 1000 * 604 / 1800 })
  assert.equal(ui.img().attrs.src, '/trickplay/thumb?kind=movie&id=abc&mt=1.2&t=600', '604 s rounds to the 600 s picture')
  track.fire('pointermove', { clientX: 5000 })
  assert.equal(ui.img().attrs.src, '/trickplay/thumb?kind=movie&id=abc&mt=1.2&t=1800')
  const tip = ui.img().parentNode
  assert.equal(tip.style.display, 'block')
  assert.equal(tip.children[1].textContent, '30:00')
  track.fire('pointerleave')
  assert.equal(tip.style.display, 'none')
  ui.img().fire('load')
  assert.equal(ui.img().style.display, 'block')
})

test('previews: a picture that fails to load is hidden and the link is refreshed at most once a minute', async () => {
  const ui = await boot({ info: { ...INFO, chapters: [] } })
  const before = ui.tpCalls().length
  ui.track().fire('pointermove', { clientX: 300 })
  ui.img().fire('error')
  await flush()
  assert.equal(ui.img().style.display, 'none')
  assert.equal(ui.tpCalls().length, before + 1)
  ui.img().fire('error')
  await flush()
  assert.equal(ui.tpCalls().length, before + 1, 'throttled')
})

test('previews: still generating -> looks again after 15 s, 30 s, 60 s, then the strip appears; disabled or bad links are ignored', async () => {
  const ui = await boot({ info: { ...INFO, chapters: [] }, trickplay: [{ ok: true, available: false, generating: true }, { ok: true, available: false, generating: true }, TP] })
  assert.equal(ui.strip(), null)
  const wait = ui.timers.filter((t) => t.ms >= 15000)
  assert.equal(wait[0].ms, 15000)
  wait[0].f()
  await flush()
  assert.equal(ui.strip(), null)
  const wait2 = ui.timers.filter((t) => t.ms >= 15000)
  assert.equal(wait2[wait2.length - 1].ms, 30000)
  wait2[wait2.length - 1].f()
  await flush()
  assert.ok(ui.strip(), 'ready on the third look')

  const off = await boot({ info: { ...INFO, chapters: [] }, trickplay: [{ ok: true, available: false, disabled: true }] })
  assert.equal(off.strip(), null)
  assert.equal(off.timers.filter((t) => t.ms >= 15000).length, 0, 'switched off: no polling')

  const bad = await boot({ info: { ...INFO, chapters: [] }, trickplay: [{ ...TP, thumbUrl: 'https://evil.example/x.jpg' }] })
  assert.equal(bad.strip(), null, 'a preview link that is not our own route is never used')
})

test('scrubbing: dragging moves the picture only, the seek happens once on release', async () => {
  const ui = await boot()
  const track = ui.track()
  ui.video.currentTime = 50
  track.fire('pointerdown', { clientX: 100 + 500, pointerId: 1 })
  track.fire('pointermove', { clientX: 100 + 900 })
  track.fire('pointermove', { clientX: 100 + 250 })
  assert.equal(ui.video.currentTime, 50, 'no seek while dragging')
  track.fire('pointerup', { clientX: 100 + 250 })
  assert.equal(Math.round(ui.video.currentTime), 450)
  ui.video.currentTime = 10
  track.fire('keydown', { key: 'ArrowRight' })
  assert.equal(ui.video.currentTime, 15)
  track.fire('keydown', { key: 'ArrowLeft', shiftKey: true })
  assert.equal(ui.video.currentTime, 0)
  track.fire('keydown', { key: 'End' })
  assert.equal(ui.video.currentTime, 1800)
})

test('subtitle style: the ::cue rule follows the saved look, sized to the video', async () => {
  const ui = await boot({ info: { ...INFO, prefs: { ...INFO.prefs, subtitleStyle: { ...STYLE, size: 150, color: '#FFEA00', bgOpacity: 50, bg: '#000000', edge: 'outline', font: 'serif' } } } })
  const rule = ui.cueRule()
  assert.match(rule, /^#v::cue\{/)
  assert.match(rule, /color:#FFEA00/)
  assert.match(rule, /background-color:rgba\(0,0,0,0\.5\)/)
  assert.match(rule, /font-family:Georgia/)
  assert.match(rule, /font-size:49px/, '720 px tall x 4.5% x 150%')
  assert.match(rule, /text-shadow:-1px -1px 0 #000000/, 'outline in a contrasting colour')
  const dark = await boot({ info: { ...INFO, prefs: { ...INFO.prefs, subtitleStyle: { ...STYLE, color: '#000000', edge: 'outline' } } } })
  assert.match(dark.cueRule(), /text-shadow:-1px -1px 0 #FFFFFF/, 'black text gets a white outline')
  assert.match((await boot()).cueRule(), /background-color:transparent/)
})

test('subtitle style: menu shows a live preview, saves only what changed, and re-applies at once', async () => {
  const ui = await boot()
  await ui.open()
  assert.ok(ui.prev())
  assert.match(ui.prev().attrs.style, /color:#FFFFFF/)
  const swatch = all(ui.body(), (e) => e.className === 'pb-sw' && e.attrs['aria-label'] === 'Yellow')[0]
  assert.ok(swatch)
  swatch.onclick()
  await flush()
  assert.deepEqual(ui.prefPosts().pop().body, { subtitleStyle: { color: '#FFEA00' } })
  assert.match(ui.cueRule(), /color:#FFEA00/)
  assert.match(ui.prev().attrs.style, /color:#FFEA00/, 'preview re-rendered with the new colour')
  const edge = all(ui.body(), (e) => e.tagName === 'button' && e.textContent === 'Depressed')[0]
  edge.onclick()
  await flush()
  assert.deepEqual(ui.prefPosts().pop().body, { subtitleStyle: { edge: 'depressed' } })
  const font = all(ui.body(), (e) => e.tagName === 'button' && e.textContent === 'Small caps')[0]
  font.onclick()
  assert.deepEqual(ui.prefPosts().pop().body, { subtitleStyle: { font: 'smallcaps' } })
  assert.match(ui.cueRule(), /font-variant:small-caps/)
  const bg = all(ui.body(), (e) => e.className === 'pb-sw' && e.attrs['aria-label'] === 'Navy')[0]
  bg.onclick()
  assert.deepEqual(ui.prefPosts().pop().body, { subtitleStyle: { bg: '#0A1A4A', bgOpacity: 60 } }, 'picking a background colour also makes it visible')
})

test('subtitle style: sliders preview while dragging and save on release; reset restores the defaults', async () => {
  const ui = await boot()
  await ui.open()
  const size = all(ui.body(), (e) => e.tagName === 'input' && e.attrs['aria-label'] === 'Size')[0]
  size.value = 180
  size.fire('input')
  assert.match(ui.prev().attrs.style, /font-size:32px/, '18 px x 180%')
  assert.equal(ui.prefPosts().length, 0, 'nothing saved while dragging')
  assert.doesNotMatch(ui.cueRule(), /font-size:58px/, 'the video is not restyled until release')
  size.fire('change')
  assert.deepEqual(ui.prefPosts().pop().body, { subtitleStyle: { size: 180 } })
  assert.match(ui.cueRule(), /font-size:58px/)
  const pos = all(ui.body(), (e) => e.tagName === 'input' && e.attrs['aria-label'] === 'Height above bottom')[0]
  pos.value = 20
  pos.fire('change')
  assert.deepEqual(ui.prefPosts().pop().body, { subtitleStyle: { position: 20 } })
  const reset = all(ui.body(), (e) => e.tagName === 'button' && e.textContent === 'Reset subtitle style')[0]
  reset.onclick()
  assert.deepEqual(ui.prefPosts().pop().body, { subtitleStyle: null })
  assert.match(ui.cueRule(), /font-size:32px/)
  assert.match(ui.cueRule(), /color:#FFFFFF/)
})

test('subtitle style: the position is applied to each cue of the shown track (bottom edge at the chosen height)', async () => {
  const ui = await boot({ info: { ...INFO, prefs: { ...INFO.prefs, subtitleStyle: { ...STYLE, position: 20 } } } })
  await ui.open()
  const cues = [{}, {}]
  const rowsAll = all(ui.body(), (e) => e.tagName === 'button' && /<span>English<\/span>/.test(e._html))
  assert.equal(rowsAll.length, 1)
  rowsAll[0].onclick()
  await flush()
  const track = ui.made.find((e) => e.tagName === 'track')
  assert.ok(track, 'the subtitle track was added')
  track.track = { cues, mode: '' }
  track.fire('load')
  for (const c of cues) assert.deepEqual([c.snapToLines, c.line, c.lineAlign], [false, 80, 'end'])
  const pos = all(ui.body(), (e) => e.tagName === 'input' && e.attrs['aria-label'] === 'Height above bottom')[0]
  await ui.open()
  const pos2 = all(ui.body(), (e) => e.tagName === 'input' && e.attrs['aria-label'] === 'Height above bottom')[0]
  pos2.value = 0
  pos2.fire('change')
  for (const c of cues) assert.equal(c.line, 100)
  assert.ok(pos)
})

const VERSIONS = [
  { id: 'abc', label: '4K HDR', height: 2160, hdr: true, edition: '', sizeBytes: 42 * 1073741824, isDefault: true, isCurrent: true, direct: { android: false, browser: false } },
  { id: 'def', label: "Director's Cut <b>1080p</b>", height: 1080, hdr: false, edition: 'Director', sizeBytes: 8 * 1048576 * 1024 / 1024 * 100, isDefault: false, isCurrent: false, direct: { android: true, browser: true } }
]

test('versions: the sheet lists each file, marks the one playing, escapes labels, and choosing one remembers it and reloads there', async () => {
  const ui = await boot({ info: { ...INFO, chapters: [], versions: VERSIONS, preferredVersionId: 'abc' }, trickplay: [{ ok: true, available: false }] })
  await ui.open()
  const head = ui.body().children.findIndex((c) => c.tagName === 'h3' && c.textContent === 'Version')
  assert.ok(head >= 0 && head < ui.body().children.findIndex((c) => c.tagName === 'h3' && c.textContent === 'Quality'), 'above Quality')
  const rows = ui.body().children.slice(head + 1, head + 3)
  assert.match(rows[0]._html, /4K HDR/)
  assert.match(rows[0]._html, /42.0 GB/)
  assert.match(rows[0]._html, /needs conversion/)
  assert.equal(rows[0].attrs['aria-pressed'], 'true')
  assert.match(rows[1]._html, /Director&#39;s Cut|Director's Cut/)
  assert.ok(rows[1]._html.includes('&lt;b&gt;1080p&lt;/b&gt;'))
  assert.doesNotMatch(rows[1]._html, /<b>/)
  assert.equal(rows[1].attrs['aria-pressed'], 'false')
  ui.video.currentTime = 754.9
  rows[1].onclick()
  await flush()
  const post = ui.calls.find((c) => c.url.includes('/playback/version'))
  assert.deepEqual(post.body, { id: 'abc', versionId: 'def' })
  assert.equal(ui.location.href, '/watch?id=def&t=754&pbv=1')
  const again = ui.body().children.find((c) => c.attrs['aria-pressed'] === 'true')
  assert.ok(again)
})

test('versions: the remembered / best version is opened once on arrival; never when already on it, already hopped, or resuming at a time', async () => {
  const withPref = (pref) => ({ ...INFO, chapters: [], versions: VERSIONS, preferredVersionId: pref })
  const a = await boot({ info: withPref('def'), trickplay: [{ ok: true, available: false }] })
  assert.equal(a.location.href, '/watch?id=def&pbv=1')
  const b = await boot({ info: withPref('abc'), trickplay: [{ ok: true, available: false }] })
  assert.equal(b.location.href, '', 'already the preferred file')
  const c = await boot({ info: withPref('def'), search: '?id=abc&pbv=1', trickplay: [{ ok: true, available: false }] })
  assert.equal(c.location.href, '', 'a hop we made ourselves never repeats')
  const d = await boot({ info: withPref('def'), search: '?id=abc&t=300', trickplay: [{ ok: true, available: false }] })
  assert.equal(d.location.href, '', 'an explicit resume link is honoured as it is')
  const e = await boot({ info: withPref('nope'), trickplay: [{ ok: true, available: false }] })
  assert.equal(e.location.href, '', 'a preferred id that is not in the list is ignored')
  const f = await boot({ info: { ...INFO, chapters: [] }, trickplay: [{ ok: true, available: false }] })
  assert.equal(f.location.href, '')
  await f.open()
  assert.equal(f.body().children.some((c) => c.tagName === 'h3' && c.textContent === 'Version'), false, 'no Version section for a single file')
})
