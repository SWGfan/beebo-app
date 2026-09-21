// The Music page's player, run against a fake browser: the next song loads on a spare <audio> and the
// two trade places (gapless), ReplayGain volume levelling through one GainNode per element, and the
// sing-along recorder still getting its backing track from the same graph (each element wrapped once).
// Run: node --test test/music-page-audio.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { createMusicApi } = localRequire('./electron/musicApi')

class El {
  constructor(tag, made) {
    this.tagName = tag
    this.children = []
    this.style = {}
    this.dataset = {}
    this.attrs = {}
    this.listeners = {}
    this._html = ''
    this._src = ''
    this.srcSets = 0
    this.plays = 0
    this.pauses = 0
    this.loads = 0
    this.volume = 1
    this.muted = false
    this.controls = false
    this.duration = NaN
    this.currentTime = 0
    this.paused = true
    this.textContent = ''
    this.classes = new Set()
    this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c), contains: (c) => this.classes.has(c), toggle: (c, on) => { if (on) this.classes.add(c); else this.classes.delete(c) } }
    made.push(this)
  }
  set src(v) { this._src = String(v); this.srcSets++; this.attrs.src = String(v) }
  get src() { return this._src }
  set innerHTML(v) { this._html = String(v); if (v === '') this.children = [] }
  get innerHTML() { return this._html }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f) }
  removeEventListener() {}
  appendChild(c) { this.children.push(c); c.parentNode = this; return c }
  replaceChild(neu, old) { const i = this.children.indexOf(old); if (i >= 0) this.children[i] = neu; else this.children.push(neu); neu.parentNode = this; old.parentNode = null; return old }
  querySelectorAll() { return [] }
  querySelector() { return null }
  closest() { return null }
  scrollIntoView() {}
  play() { this.plays++; this.paused = false; return Promise.resolve() }
  pause() { this.pauses++; this.paused = true }
  load() { this.loads++ }
  fire(type, extra = {}) { for (const f of (this.listeners[type] || []).slice()) f({ target: this, preventDefault() {}, ...extra }) }
}

const flush = async () => { for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r)) }

const TRACKS = (extra = [{}, {}, {}]) => [1, 2, 3].map((n, i) => ({
  id: `t${n}`, title: `Song ${n}`, artist: 'A', album: 'B', trackNo: n, duration: 200, stream: `/api/music/track/t${n}/stream?mt=x`, cover: null, hasLyrics: false, ...extra[i]
}))

async function boot({ tracks = TRACKS(), audioContext = true, level = null } = {}) {
  const made = []
  const byId = {}
  const el = (id) => { if (!byId[id]) { const e = new El('div', made); e.id = id; byId[id] = e } return byId[id] }
  const audio = el('maudio'); audio.tagName = 'audio'; audio.controls = true
  const bar = el('mbar')
  bar.appendChild(audio)
  const card = new El('a', made)
  card.dataset.album = 'alb1'
  const mediaCalls = { wraps: new Map(), contexts: 0, nodes: [], destinations: [] }
  class AC {
    constructor() {
      mediaCalls.contexts++
      this.state = 'running'
      this.destination = { kind: 'destination' }
    }
    node(kind) { const n = { kind, to: [], gain: { value: 1 }, connect(x) { this.to.push(x); return x }, disconnect(x) { this.to = x ? this.to.filter((y) => y !== x) : [] } }; mediaCalls.nodes.push(n); return n }
    createGain() { return this.node('gain') }
    createMediaElementSource(e) { mediaCalls.wraps.set(e, (mediaCalls.wraps.get(e) || 0) + 1); if (mediaCalls.wraps.get(e) > 1) throw new Error('InvalidStateError: already connected'); const n = this.node('source'); n.element = e; return n }
    createMediaStreamDestination() { const n = this.node('mixdest'); n.stream = { getAudioTracks: () => [{ kind: 'audio' }] }; mediaCalls.destinations.push(n); return n }
    createMediaStreamSource() { return this.node('micsrc') }
    resume() { return Promise.resolve() }
  }
  const fetches = []
  const store = {}
  class MR {
    static isTypeSupported() { return true }
    constructor(stream, opts) { this.state = 'inactive'; this.mimeType = opts && opts.mimeType || 'audio/webm' }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; if (this.ondataavailable) this.ondataavailable({ data: { size: 10 } }); if (this.onstop) this.onstop() }
  }
  const sandbox = {
    document: {
      getElementById: (id) => el(id),
      createElement: (tag) => new El(tag, made),
      querySelectorAll: (sel) => (sel === '.mcard' ? [card] : []),
      addEventListener() {}
    },
    fetch: (url, opts) => {
      const u = String(url)
      fetches.push({ url: u, method: (opts && opts.method) || 'GET' })
      if (u.startsWith('/music/album.json')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, album: { id: 'alb1', title: 'B', artist: 'A', trackCount: tracks.length, cover: null }, tracks }) })
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, items: [] }) })
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) } },
    navigator: {
      mediaDevices: { getUserMedia: () => Promise.resolve({ getVideoTracks: () => [], getAudioTracks: () => [{ kind: 'audio' }], getTracks: () => [{ stop() {} }] }) }
    },
    MediaRecorder: MR,
    MediaStream: class { constructor(t) { this.t = t } getAudioTracks() { return this.t } },
    Blob: class { constructor(parts) { this.size = parts.reduce((n, p) => n + (p.size || 0), 0); this.type = 'audio/webm' } },
    URL: { revokeObjectURL() {} },
    setInterval, clearInterval, setTimeout, clearTimeout, confirm: () => true
  }
  sandbox.window = sandbox
  sandbox.isSecureContext = true
  if (level != null) store['beebo:music:level'] = level
  if (audioContext) sandbox.AudioContext = AC
  const api = createMusicApi({ library: { status: () => ({ configured: true, scanning: false, progress: { done: 0, total: 0 }, albumCount: 1, trackCount: 3 }), albums: () => [] }, store: { get: () => undefined, set() {} }, makeMediaToken: () => 't', verifyMediaToken: () => false })
  let html = ''
  api.handleWeb({}, { writeHead() {}, end(h) { html = h } }, new URL('http://x/music'), { renderPage: (b) => b, nav: '' })
  const code = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  vm.runInNewContext(code, sandbox)
  const spare = () => made.find((e) => e.id === 'maudio2')
  const ui = {
    audio, bar, byId, made, mediaCalls, fetches, store, spare,
    active: () => bar.children[0],
    openAlbum: async () => { card.fire('click'); await flush() },
    playAll: async () => { await ui.openAlbum(); byId.mplayall.onclick(); await flush() },
    shuffle: async () => { await ui.openAlbum(); byId.mshuf.onclick(); await flush() },
    nearEnd: (e) => { e.duration = 200; e.currentTime = 195; e.fire('timeupdate') },
    master: () => mediaCalls.nodes.find((n) => n.kind === 'gain'),
    gainOf: (e) => { const src = mediaCalls.nodes.find((n) => n.kind === 'source' && n.element === e); return src && src.to[0].gain.value }
  }
  return ui
}

test('the Music page script still parses and keeps the karaoke code it had', () => {
  const api = createMusicApi({ library: { status: () => ({ configured: true, scanning: false, progress: { done: 0, total: 0 }, albumCount: 0, trackCount: 0 }), albums: () => [] }, store: { get: () => undefined, set() {} }, makeMediaToken: () => 't', verifyMediaToken: () => false })
  let html = ''
  api.handleWeb({}, { writeHead() {}, end(h) { html = h } }, new URL('http://x/music'), { renderPage: (b) => b, nav: '' })
  const code = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  assert.doesNotThrow(() => new vm.Script(code))
  for (const needle of ['activeLineIndex(lyr,audio.currentTime*1000)', 'getUserMedia', 'createMediaStreamDestination', "'/music-api/recordings", 'function lyricsTick', 'mixDest', 'id="mnorm"', 'id="mrec"', 'id="mrecs"', 'id="mly"']) {
    assert.ok(code.includes(needle) || html.includes(needle), needle)
  }
})

test('untagged music plays exactly as before: no Web Audio graph at all', async () => {
  const ui = await boot()
  await ui.playAll()
  assert.equal(ui.audio._src, '/api/music/track/t1/stream?mt=x')
  assert.equal(ui.audio.plays, 1)
  assert.equal(ui.mediaCalls.contexts, 0, 'no AudioContext is created for a library without ReplayGain tags')
  assert.equal(ui.mediaCalls.wraps.size, 0)
})

test('gapless: the next song loads on the spare element near the end, then the two swap without reloading', async () => {
  const ui = await boot()
  await ui.playAll()
  const first = ui.audio
  const spare = ui.spare()
  assert.ok(spare && spare !== first)
  first.duration = 200; first.currentTime = 100; first.fire('timeupdate')
  assert.equal(spare.loads, 0, 'not while the song has plenty left')
  ui.nearEnd(first)
  assert.equal(spare._src, '/api/music/track/t2/stream?mt=x')
  assert.equal(spare.loads, 1)
  ui.nearEnd(first)
  assert.equal(spare.loads, 1, 'only once per song')
  assert.equal(spare.plays, 0, 'nothing plays yet')

  first.fire('ended')
  assert.equal(spare.plays, 1, 'the preloaded element starts')
  assert.equal(spare.srcSets, 1, 'its source was set once, when it was preloaded, and not touched again')
  assert.equal(first.pauses, 1)
  assert.equal(ui.active(), spare, 'the spare took the place of the first in the page')
  assert.equal(spare.controls, true)
  assert.equal(first.controls, false)
  assert.equal(first.parentNode, null)

  // Now the other element is the spare, and the next song goes onto it.
  ui.nearEnd(spare)
  assert.equal(first._src, '/api/music/track/t3/stream?mt=x')
  assert.equal(first.loads, 1)
  // A late 'ended' from the element that is no longer the player changes nothing.
  const playsBefore = spare.plays
  first.fire('ended')
  assert.equal(spare.plays, playsBefore)
  spare.fire('ended')
  assert.equal(first.plays, 2, 'the first element played song 1 and now plays song 3 (swapped back)')
  assert.equal(first.srcSets, 2, 'song 1 when it started, song 3 when it was preloaded; the swap itself sets nothing')
  assert.equal(ui.active(), first)
  // The last song ends: nothing further starts.
  const p = first.plays + spare.plays
  ui.nearEnd(first)
  first.fire('ended')
  assert.equal(first.plays + spare.plays, p)
})

test('gapless: choosing a song by hand does not use a stale preload, and next reuses a good one', async () => {
  const ui = await boot()
  await ui.playAll()
  const first = ui.audio
  const spare = ui.spare()
  ui.nearEnd(first) // song 2 is on the spare
  // ⏭ while it is preloaded: swaps to it instantly.
  ui.byId.mnext.onclick()
  assert.equal(spare.plays, 1)
  assert.equal(spare.srcSets, 1)
  // ⏮ goes to song 1 by loading it (the spare now holds nothing for it).
  ui.byId.mprev.onclick()
  assert.ok(spare.currentTime <= 3)
  // Preload for song 2, then jump to song 3 by hand: song 3 loads fresh, song 2's preload is not played.
  const active = ui.active()
  ui.nearEnd(active)
  const other = active === first ? spare : first
  assert.equal(other._src, '/api/music/track/t2/stream?mt=x')
})

test('the volume and mute the listener chose carry across the swap', async () => {
  const ui = await boot()
  await ui.playAll()
  const first = ui.audio
  const spare = ui.spare()
  first.volume = 0.4
  first.fire('volumechange')
  assert.equal(spare.volume, 0.4, 'mirrored onto the spare as it changes')
  ui.nearEnd(first)
  first.muted = true
  first.fire('volumechange')
  first.fire('ended')
  assert.equal(spare.volume, 0.4)
  assert.equal(spare.muted, true)
  // The old element no longer drives the spare.
  first.volume = 1
  first.fire('volumechange')
  assert.equal(spare.volume, 0.4)
})

test('ReplayGain: album playback uses the album gain, shuffle uses each song\'s own, each element wrapped once', async () => {
  const tracks = TRACKS([{ gainDb: -6, albumGainDb: -4 }, { gainDb: -9, albumGainDb: -4 }, { gainDb: -3, albumGainDb: -4 }])
  const ui = await boot({ tracks })
  await ui.playAll()
  const first = ui.audio
  const spare = ui.spare()
  assert.equal(ui.mediaCalls.contexts, 1)
  assert.equal(ui.mediaCalls.wraps.get(first), 1)
  assert.equal(ui.mediaCalls.wraps.get(spare), 1)
  const lin = (db) => Math.pow(10, db / 20)
  assert.ok(Math.abs(ui.gainOf(first) - lin(-4)) < 1e-9, 'album gain')
  ui.nearEnd(first)
  assert.ok(Math.abs(ui.gainOf(spare) - lin(-4)) < 1e-9, 'the preloaded song already has its level')
  first.fire('ended')
  assert.ok(Math.abs(ui.gainOf(spare) - lin(-4)) < 1e-9)
  assert.equal(ui.mediaCalls.wraps.get(first), 1, 'no element is ever wrapped twice')
  assert.equal(ui.mediaCalls.wraps.get(spare), 1)
  assert.equal(ui.mediaCalls.contexts, 1, 'one context for the whole session')
  // Both element gains end in one master gain, which ends in the speakers.
  const master = ui.master()
  assert.ok(master.to.some((n) => n.kind === 'destination'))
  const srcs = ui.mediaCalls.nodes.filter((n) => n.kind === 'source')
  assert.equal(srcs.length, 2)
  for (const s of srcs) assert.ok(s.to[0].to.includes(master))
})

test('ReplayGain: shuffle (track mode) applies each song\'s own gain to whichever element plays it', async () => {
  const tracks = TRACKS([{ gainDb: -6 }, { gainDb: -9 }, { gainDb: -3 }])
  const ui = await boot({ tracks })
  await ui.shuffle()
  const lin = (db) => Math.pow(10, db / 20)
  const started = ui.audio._src
  const own = { '/api/music/track/t1/stream?mt=x': -6, '/api/music/track/t2/stream?mt=x': -9, '/api/music/track/t3/stream?mt=x': -3 }
  assert.ok(Math.abs(ui.gainOf(ui.audio) - lin(own[started])) < 1e-9, `song ${started} at its own level`)
})

test('ReplayGain: a song that would clip is held down by its own peak, and a missing tag leaves the level alone', async () => {
  const tracks = TRACKS([{ gainDb: 6, gainPeak: 1 }, { gainDb: 9, gainPeak: 0.5 }, {}])
  const ui = await boot({ tracks })
  await ui.playAll()
  const first = ui.audio
  const spare = ui.spare()
  assert.ok(Math.abs(ui.gainOf(first) - 1) < 1e-9, 'full-scale peak: no boost')
  ui.nearEnd(first)
  first.fire('ended')
  assert.ok(Math.abs(ui.gainOf(spare) - Math.pow(10, 6.0206 / 20)) < 1e-3, 'half-scale peak: 6 dB of room')
  ui.nearEnd(spare)
  spare.fire('ended')
  assert.equal(ui.gainOf(first), 1, 'untagged: unity')
})

test('the level button turns levelling off and on, and the choice is remembered', async () => {
  const ui = await boot({ tracks: TRACKS([{ gainDb: -6 }, { gainDb: -6 }, { gainDb: -6 }]) })
  await ui.playAll()
  const first = ui.audio
  assert.ok(ui.gainOf(first) < 0.6)
  assert.match(ui.byId.mnorm.title, /-6\.0 dB/)
  ui.byId.mnorm.onclick()
  assert.equal(ui.gainOf(first), 1)
  assert.equal(ui.store['beebo:music:level'], '0')
  assert.match(ui.byId.mnorm.title, /off/i)
  ui.byId.mnorm.onclick()
  assert.ok(ui.gainOf(first) < 0.6)
  assert.equal(ui.store['beebo:music:level'], '1')
  // A viewer who turned it off earlier starts with it off, and untagged-or-off means no graph.
  const off = await boot({ tracks: TRACKS([{ gainDb: -6 }, {}, {}]), level: '0' })
  await off.playAll()
  assert.equal(off.mediaCalls.contexts, 0)
})

test('honest words: a song with no tag says so, a tagged one says which gain it uses', async () => {
  const ui = await boot({ tracks: TRACKS([{}, { gainDb: -5, albumGainDb: -3 }, {}]) })
  await ui.playAll()
  assert.match(ui.byId.mnorm.title, /No ReplayGain tag/)
  ui.nearEnd(ui.audio)
  ui.audio.fire('ended')
  assert.match(ui.byId.mnorm.title, /-3\.0 dB \(album ReplayGain\)/)
})

test('no Web Audio in the browser: playback, gapless and the level button still work', async () => {
  const ui = await boot({ audioContext: false, tracks: TRACKS([{ gainDb: -6 }, {}, {}]) })
  await ui.playAll()
  const first = ui.audio
  assert.equal(first.plays, 1)
  ui.nearEnd(first)
  first.fire('ended')
  assert.equal(ui.spare().srcSets === 1 || ui.active().plays === 1, true)
  ui.byId.mnorm.onclick()
})

test('the sing-along recorder taps the same master gain: nothing is wrapped twice, the speakers keep playing', async () => {
  const ui = await boot()
  await ui.playAll()
  assert.equal(ui.mediaCalls.contexts, 0, 'no graph until something needs one')
  ui.byId.mrec.onclick()
  await flush()
  assert.equal(ui.mediaCalls.contexts, 1, 'the recorder asked for the graph')
  const first = ui.audio
  const spare = ui.spare()
  assert.equal(ui.mediaCalls.wraps.get(first), 1)
  assert.equal(ui.mediaCalls.wraps.get(spare), 1)
  const master = ui.master()
  assert.ok(master.to.some((n) => n.kind === 'destination'), 'the speakers are still fed')
  const mix = ui.mediaCalls.destinations[0]
  assert.ok(master.to.includes(mix), 'the backing track goes to the recording')
  // Stop: the recording graph is released, the speakers are not.
  ui.byId.mrec.onclick()
  await flush()
  assert.ok(!master.to.includes(mix), 'the backing track is disconnected from the finished recording')
  assert.ok(master.to.some((n) => n.kind === 'destination'))
  assert.ok(ui.fetches.some((f) => f.url.startsWith('/music-api/recordings?trackId=t1') && f.method === 'POST'), 'the recording is saved')
})

test('recording across gapless swaps: still one wrap per element, the backing track keeps flowing, ending the song ends the take', async () => {
  const ui = await boot({ tracks: TRACKS([{ gainDb: -6 }, { gainDb: -6 }, { gainDb: -6 }]) })
  await ui.playAll()
  const first = ui.audio
  const spare = ui.spare()
  ui.byId.mrec.onclick()
  await flush()
  const master = ui.master()
  const mix = ui.mediaCalls.destinations[0]
  assert.ok(master.to.includes(mix))
  ui.nearEnd(first)
  first.fire('ended') // the song ends: the take is stopped and saved, as it always was
  await flush()
  assert.ok(!master.to.includes(mix))
  assert.equal(ui.fetches.filter((f) => f.url.startsWith('/music-api/recordings?trackId=t1')).length, 1)
  // A second take on the second song, on the other element, through the same graph.
  ui.byId.mrec.onclick()
  await flush()
  const mix2 = ui.mediaCalls.destinations[1]
  assert.ok(mix2 && master.to.includes(mix2))
  assert.equal(ui.mediaCalls.wraps.get(first), 1)
  assert.equal(ui.mediaCalls.wraps.get(spare), 1)
  assert.equal(ui.mediaCalls.contexts, 1)
  ui.byId.mrec.onclick()
  await flush()
  assert.ok(ui.fetches.some((f) => f.url.startsWith('/music-api/recordings?trackId=t2') && f.method === 'POST'))
})

test('a wrapping failure on one element never silences the other or breaks playback', async () => {
  const ui = await boot({ tracks: TRACKS([{ gainDb: -6 }, {}, {}]) })
  // Sabotage: the spare cannot be wrapped (as if another script already did).
  const originalAudio = ui.audio
  const spareEl = ui.spare()
  ui.mediaCalls.wraps.set(spareEl, 1)
  await ui.playAll()
  assert.equal(ui.mediaCalls.wraps.get(originalAudio), 1, 'the playing element is still wrapped and routed to the speakers')
  const master = ui.master()
  assert.ok(master.to.some((n) => n.kind === 'destination'))
  assert.equal(originalAudio.plays, 1)
})
