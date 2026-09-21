// The web player's Sound menu, run for real against a tiny fake browser (no DOM library needed):
// what it asks the PC for, what it remembers, what it says is playing, and how Web Audio boost and
// delay are wired - including the browsers that must be kept out of Web Audio.
// Run: node --test test/playback-web-audio.test.js
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
  querySelector() { return null }
  text() { return `${this._html} ${this.textContent} ${this.children.map((c) => c.text()).join(' ')}`.replace(/\s+/g, ' ').trim() }
  fire(type, extra = {}) { for (const f of this.listeners[type] || []) f({ target: this, ...extra }) }
}

const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)) }

const INFO = {
  ok: true, kind: 'movie', id: 'abc', durationSec: 100, bitrateKbps: 8000,
  video: { codec: 'h264', width: 1920, height: 1080, fps: 24, hdr: false },
  original: { label: 'Original · 1080p', height: 1080 },
  direct: { android: true, browser: false },
  qualities: [{ id: '1080p', label: '1080p', videoKbps: 8000, upscale: false }, { id: '720p', label: '720p', videoKbps: 4000, upscale: false }, { id: '480p', label: '480p', videoKbps: 1500, upscale: false }],
  transcode: { available: true, encoder: 'libx264' },
  audio: [
    { ordinal: 0, streamIndex: 1, label: 'English · 5.1 · Dolby Digital', language: 'eng', codec: 'ac3', channels: 6, isDefault: true, playsAs: { label: 'Surround 5.1 · Dolby Digital', detail: 'original audio, played as stored' } },
    { ordinal: 1, streamIndex: 2, label: 'Spanish · Stereo · AAC', language: 'spa', codec: 'aac', channels: 2, isDefault: false, playsAs: { label: 'Stereo · AAC', detail: 'original audio, played as stored' } }
  ],
  audioOptions: { surroundAvailable: true, normalizeNote: 'Loudness levelling uses roughly a third of one processor core while a 5.1 film converts.' },
  subtitles: [], onlineSearch: { configured: false },
  prefs: { quality: 'auto', audioLanguage: '', subtitleLanguage: '', subtitlesOn: false, audioMode: 'auto', downmix: 'standard', night: false, normalize: false, boostDb: 0, audioDelayMs: 0 }
}

async function boot({ info = INFO, prefs = {}, channels = 0, native = false, audioContext = false, planFor = null } = {}) {
  const js = playbackPanelHtml({ kind: 'movie', mediaId: 'abc' }).split('<script>')[1].split('</script>')[0]
  const made = []
  const byId = {}
  const el = (id, tag = 'div') => { if (!byId[id]) { const e = new El(tag, made); e.id = id; byId[id] = e } return byId[id] }
  const video = el('v', 'video')
  Object.assign(video, {
    currentTime: 0, paused: true, currentSrc: '',
    canPlayType: (t) => (native && /mpegurl/i.test(t) ? 'maybe' : ''),
    play: () => Promise.resolve()
  })
  video.attrs.src = '/file/original.mkv'
  const cast = el('castBtn', 'button')
  cast.parentNode = { insertBefore: (c) => c }
  const calls = []
  const ticketN = { n: 0 }
  let prefsState = { ...INFO.prefs, ...info.prefs, ...prefs }
  const respond = (body) => Promise.resolve({ json: () => Promise.resolve(body), arrayBuffer: () => Promise.resolve(new ArrayBuffer(2 * 1024 * 1024)) })
  const fetchStub = (url, opts) => {
    const u = String(url)
    const body = opts && opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body })
    if (u.includes('/playback/info')) return respond({ ...info, prefs: prefsState })
    if (u.includes('/playback/speedtest')) return respond({})
    if (u.includes('/playback/prefs')) { prefsState = { ...prefsState, ...body }; return respond({ ok: true, prefs: prefsState }) }
    if (u.includes('/playback/start')) {
      ticketN.n++
      return respond({ ok: true, url: `/hls/T${ticketN.n}/index.m3u8`, ticket: `T${ticketN.n}`, quality: body.quality, audioPlan: planFor ? planFor(body) : { label: 'Stereo (mixed down from 5.1) · AAC', detail: 'converted from Dolby Digital' } })
    }
    return respond({ ok: true })
  }
  const graphLog = { nodes: [], sources: 0, resumed: 0, contexts: 0 }
  class AC {
    constructor() {
      graphLog.contexts++
      this.state = 'suspended'
      this.destination = { maxChannelCount: channels || 2, name: 'destination' }
    }
    createMediaElementSource(e) { graphLog.sources++; const n = this.node('source'); n.element = e; return n }
    createGain() { const n = this.node('gain'); n.gain = { value: 1 }; return n }
    createDelay() { const n = this.node('delay'); n.delayTime = { value: 0 }; return n }
    createWaveShaper() { const n = this.node('shaper'); n.curve = null; return n }
    node(kind) { const n = { kind, to: [], connect(x) { this.to.push(x); return x }, disconnect() { this.to = [] } }; graphLog.nodes.push(n); return n }
    resume() { graphLog.resumed++; this.state = 'running'; return Promise.resolve() }
    close() { return Promise.resolve() }
  }
  class Hls {
    static isSupported() { return true }
    loadSource() {}
    attachMedia() {}
    on() {}
    destroy() {}
  }
  Hls.Events = { MANIFEST_PARSED: 'm' }
  const sandbox = {
    document: {
      getElementById: (id) => (['v', 'castBtn', 'pbSheet', 'pbClose', 'pbBody'].includes(id) || byId[id] ? el(id) : (id === 'pbLang' ? null : el(id))),
      createElement: (tag) => new El(tag, made),
      addEventListener() {}, body: new El('body', made), head: new El('head', made)
    },
    fetch: fetchStub,
    performance: { now: () => Date.now() },
    navigator: {},
    Blob: class {},
    Hls,
    setTimeout, clearTimeout
  }
  sandbox.window = sandbox
  sandbox.addEventListener = () => {}
  if (audioContext) sandbox.AudioContext = AC
  vm.runInNewContext(js, sandbox)
  await flush()
  const ui = {
    calls, made, video, graphLog, byId, prefs: () => prefsState,
    starts: () => calls.filter((c) => c.url.includes('/playback/start')),
    prefPosts: () => calls.filter((c) => c.url.includes('/playback/prefs') && c.method === 'POST'),
    open: async () => { made.find((e) => e.id === 'pbBtn').onclick(); await flush() },
    body: () => byId.pbBody,
    rows: () => byId.pbBody.children.filter((c) => c.tagName === 'button' && c.classes.size === 0 || c.className === 'pb-row'),
    row: (label) => byId.pbBody.children.find((c) => c.tagName === 'button' && c._html.includes('<span>' + label + '</span>')),
    click: async (label) => { const r = ui.row(label); assert.ok(r, `row "${label}" exists in: ${byId.pbBody.text()}`); r.onclick(); await flush() },
    slider: (label) => byId.pbBody.children.map((w) => (w.className === 'pb-slide' ? w : null)).filter(Boolean).find((w) => w.children[0].textContent === label),
    setSlider: async (label, value, fireInput = true) => {
      const w = ui.slider(label)
      assert.ok(w, `slider ${label}`)
      const input = w.children[1]
      input.value = String(value)
      if (fireInput) input.fire('input')
      input.fire('change')
      await flush()
    },
    text: () => byId.pbBody.text()
  }
  return ui
}

test('web player script parses, embeds the id safely, has no backtick or template hazards', () => {
  const html = playbackPanelHtml({ kind: 'tv', mediaId: 'x</script><b>' })
  const parts = html.split('<script>')
  assert.equal(parts.length, 2)
  const js = parts[1].split('</script>')[0]
  assert.doesNotThrow(() => new vm.Script(js))
  assert.doesNotMatch(js, /\$\{/, 'nothing left uninterpolated')
  for (const word of ['Sound mode', 'Night mode', 'Dialogue boost', 'Audio delay', 'Volume levelling', 'Stereo mix-down']) {
    assert.match(js, new RegExp(word.replace('-', '\\-')), word)
  }
  assert.doesNotMatch(js, /https?:\/\/(?!$)[a-z]/i, 'no outside sites')
})

test('a default viewer: converted playback asks for auto sound with what this browser can play, nothing else', async () => {
  const ui = await boot()
  const starts = ui.starts()
  assert.equal(starts.length, 1, 'browser cannot play the original, so it converts once')
  const b = starts[0].body
  assert.equal(b.kind, 'movie')
  assert.equal(b.audioMode, 'auto')
  assert.equal(b.downmix, 'standard')
  assert.equal(b.night, false)
  assert.equal(b.normalize, false)
  assert.equal('audioDelayMs' in b, false)
  assert.deepEqual(b.audioCaps, { maxChannels: 2, codecs: ['aac'] }, 'no Web Audio here, so it says stereo and AAC only')
  await ui.open()
  assert.match(ui.text(), /Stereo \(mixed down from 5\.1\) · AAC/, 'the info line says what is really playing')
  assert.match(ui.text(), /converted from Dolby Digital/)
})

test('the info line for a file played as it is comes from the file itself', async () => {
  const ui = await boot({ prefs: { quality: 'original' }, info: { ...INFO, direct: { android: true, browser: true } } })
  assert.equal(ui.starts().length, 0, 'the original plays')
  await ui.open()
  assert.match(ui.text(), /Surround 5\.1 · Dolby Digital/)
  assert.match(ui.text(), /original audio, played as stored/)
})

test('speakers that report 6 channels make Auto ask for surround; codecs the browser can play are listed', async () => {
  const ui = await boot({ audioContext: true, channels: 6 })
  const b = ui.starts()[0].body
  assert.equal(b.audioCaps.maxChannels, 6)
  assert.deepEqual(b.audioCaps.codecs, ['aac'])
  await ui.open()
  assert.match(ui.text(), /surround, your speakers report 6 channels/)
})

test('Sound mode choices are remembered and re-convert with the new request', async () => {
  const ui = await boot()
  await ui.open()
  await ui.click('Surround')
  assert.deepEqual(ui.prefPosts().pop().body, { audioMode: 'surround' })
  let b = ui.starts().pop().body
  assert.equal(b.audioMode, 'auto')
  assert.equal(b.audioCaps.maxChannels, 6, 'explicit surround asserts six channels')
  await ui.click('Stereo')
  assert.deepEqual(ui.prefPosts().pop().body, { audioMode: 'stereo' })
  b = ui.starts().pop().body
  assert.equal(b.audioMode, 'stereo')
  assert.equal('audioCaps' in b, false, 'explicit stereo sends no caps')
  const n = ui.starts().length
  await ui.click('Night mode')
  assert.deepEqual(ui.prefPosts().pop().body, { night: true })
  assert.equal(ui.starts().length, n + 1)
  assert.equal(ui.starts().pop().body.night, true)
  await ui.click('Volume levelling')
  assert.deepEqual(ui.prefPosts().pop().body, { normalize: true })
  assert.equal(ui.starts().pop().body.normalize, true)
  assert.match(ui.text(), /third of one processor core/, 'the cost is stated')
  await ui.click('Stereo mix-down: dialogue focus')
  assert.deepEqual(ui.prefPosts().pop().body, { downmix: 'dialogue' })
  assert.equal(ui.starts().pop().body.downmix, 'dialogue')
  // Each change stops the previous conversion so pieces are never mixed.
  assert.ok(ui.calls.filter((c) => c.url.includes('/playback/stop')).length >= 3)
})

test('remembered audio choices are sent from the first request of the next visit', async () => {
  const ui = await boot({ prefs: { audioMode: 'stereo', night: true, downmix: 'dialogue', normalize: true, audioDelayMs: -80 } })
  const b = ui.starts()[0].body
  assert.deepEqual({ audioMode: b.audioMode, downmix: b.downmix, night: b.night, normalize: b.normalize, audioDelayMs: b.audioDelayMs }, { audioMode: 'stereo', downmix: 'dialogue', night: true, normalize: true, audioDelayMs: -80 })
})

test('without Web Audio (or on native-HLS browsers) boost is disabled and every delay is made by the PC', async () => {
  for (const cfg of [{ audioContext: false }, { audioContext: true, native: true }]) {
    const ui = await boot(cfg)
    await ui.open()
    assert.equal(ui.slider('Dialogue boost').children[1].disabled, true, JSON.stringify(cfg))
    assert.match(ui.text(), /Not available in this browser/)
    const before = ui.starts().length
    await ui.setSlider('Audio delay', 120)
    assert.equal(ui.prefPosts().pop().body.audioDelayMs, 120)
    assert.equal(ui.starts().length, before + 1, 'a positive delay needs the converter here')
    assert.equal(ui.starts().pop().body.audioDelayMs, 120)
    assert.equal(ui.graphLog.sources, 0, 'the video element is never routed through Web Audio')
    assert.match(ui.text(), /the PC makes the delay/)
  }
})

test('with Web Audio: boost and positive delay stay in the browser, negative delay goes to the PC', async () => {
  const ui = await boot({ audioContext: true })
  await ui.open()
  assert.equal(ui.graphLog.sources, 0, 'untouched until asked')
  const starts = ui.starts().length
  await ui.setSlider('Dialogue boost', 4)
  assert.deepEqual(ui.prefPosts().pop().body, { boostDb: 4 })
  assert.equal(ui.starts().length, starts, 'boost never converts')
  assert.equal(ui.graphLog.sources, 1)
  const gain = ui.graphLog.nodes.find((n) => n.kind === 'gain')
  const shaper = ui.graphLog.nodes.find((n) => n.kind === 'shaper')
  assert.ok(Math.abs(gain.gain.value - Math.pow(10, 4 / 20)) < 1e-9)
  assert.ok(shaper.curve && shaper.curve.length > 100, 'a limiter curve is set')
  let peak = 0
  for (const y of shaper.curve) peak = Math.max(peak, Math.abs(y))
  assert.ok(peak <= 1.0000001, 'the curve never exceeds full scale')
  const mid = shaper.curve[Math.round(shaper.curve.length * (0.5 + 0.5 * 0.4))]
  assert.ok(Math.abs(mid - 0.4) < 0.01, 'quiet sound passes untouched below the knee')
  assert.match(ui.text(), /dialogue boost \+4 dB/i)

  await ui.setSlider('Audio delay', 150)
  assert.equal(ui.starts().length, starts, 'a positive delay is a DelayNode, not a conversion')
  const delay = ui.graphLog.nodes.find((n) => n.kind === 'delay')
  assert.ok(Math.abs(delay.delayTime.value - 0.15) < 1e-9)
  assert.match(ui.text(), /\+150 ms delay \(in your browser\)/)

  await ui.setSlider('Audio delay', -200)
  assert.equal(ui.starts().length, starts + 1, 'negative delay needs the converter')
  assert.equal(ui.starts().pop().body.audioDelayMs, -200)
  assert.equal(delay.delayTime.value, 0, 'and the browser delay is released')
  assert.equal(ui.graphLog.sources, 1, 'still exactly one media source for the element')

  await ui.setSlider('Dialogue boost', 0)
  const source = ui.graphLog.nodes.find((n) => n.kind === 'source')
  assert.ok(source.to.length === 1 && source.to[0].name === 'destination', 'no boost and no delay: straight to the speakers')
})

test('boost is clamped by the slider to 6 dB and a limiter curve is used for any boost', async () => {
  const ui = await boot({ audioContext: true, prefs: { boostDb: 6 } })
  const gain = ui.graphLog.nodes.find((n) => n.kind === 'gain')
  assert.ok(gain, 'a remembered boost is applied on load')
  assert.ok(Math.abs(gain.gain.value - Math.pow(10, 6 / 20)) < 1e-9)
  await ui.open()
  const slider = ui.slider('Dialogue boost').children[1]
  assert.equal(slider.max, 6)
  assert.equal(slider.min, 0)
  const delay = ui.slider('Audio delay').children[1]
  assert.equal(delay.min, -500)
  assert.equal(delay.max, 500)
})

test('the sound menu offers only what the film and PC can do', async () => {
  const stereoOnly = { ...INFO, audio: [INFO.audio[1]], audioOptions: { surroundAvailable: false } }
  const ui = await boot({ info: stereoOnly })
  await ui.open()
  assert.equal(ui.row('Surround'), undefined, 'no Surround row for a stereo film')
  assert.equal(ui.row('Stereo mix-down: standard'), undefined, 'no mix-down choice when there is nothing to mix down')
  assert.ok(ui.row('Night mode'))
  const noTranscode = await boot({ info: { ...INFO, transcode: { available: false, reason: 'off' } }, prefs: { quality: 'original', night: true } })
  assert.equal(noTranscode.starts().length, 0, 'never asks the PC to convert when conversion is unavailable')
  await noTranscode.open()
  assert.match(noTranscode.text(), /needs conversion/)
})

test('a night-mode viewer on Original is moved to a conversion (only the PC can process the sound)', async () => {
  const ui = await boot({ info: { ...INFO, direct: { android: true, browser: true } }, prefs: { quality: 'original', night: true } })
  assert.equal(ui.starts().length, 1)
  assert.equal(ui.starts()[0].body.night, true)
  assert.notEqual(ui.starts()[0].body.quality, 'original')
})

test('a plain viewer on Original is left alone (no conversion, no Web Audio)', async () => {
  const ui = await boot({ info: { ...INFO, direct: { android: true, browser: true } }, prefs: { quality: 'original' }, audioContext: true })
  assert.equal(ui.starts().length, 0)
  assert.equal(ui.graphLog.sources, 0)
})

test('old servers that do not know the sound options still work', async () => {
  const old = { ...INFO }
  delete old.audioOptions
  old.audio = INFO.audio.map((a) => { const { playsAs, ...rest } = a; return rest })
  const ui = await boot({ info: old, planFor: () => undefined })
  await ui.open()
  assert.ok(ui.text().includes('Sound'))
  assert.equal(ui.row('Surround'), undefined)
})
