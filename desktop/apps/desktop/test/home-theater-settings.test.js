// Settings > Playback > Home theater (homeTheaterSettings.js + its IPC in playbackSettingsIpc.js): defaults, clamping,
// the per-person override (a missing / null field inherits), and that what the window saves is what the decision reads.
// Run: node --test test/home-theater-settings.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.join(path.resolve(__dirname, '..'), 'package.json'))
const ht = localRequire('./electron/homeTheaterSettings')
const ipc = localRequire('./electron/playbackSettingsIpc')
const dp = localRequire('./electron/deviceProfile')
const decision = localRequire('./electron/playbackDecision')
const tracksLib = localRequire('./electron/playbackTracks')
const F = require('./helpers/ffprobeFixtures')

const memStore = (init = {}) => { const m = new Map(Object.entries(init)); return { get: (k) => m.get(k), set: (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))) }, all: m } }

test('defaults: direct play preferred, no bitrate limit, passthrough allowed, direct stream allowed, no forced transcode', () => {
  assert.deepEqual(ht.normalize(undefined), { directPlayPreferred: true, maxBitrateKbps: 0, allowPassthrough: true, allowDirectStream: true, forceTranscode: false })
  assert.deepEqual(ht.normalize(null), ht.DEFAULTS)
  assert.equal(Object.isFrozen(ht.DEFAULTS), true)
})

test('normalize: only booleans and non-negative numbers survive, the bitrate is clamped', () => {
  const n = ht.normalize({ directPlayPreferred: 'yes', maxBitrateKbps: '25000', allowPassthrough: 0, allowDirectStream: false, forceTranscode: 1, extra: 1 })
  assert.deepEqual(n, { directPlayPreferred: true, maxBitrateKbps: 25000, allowPassthrough: true, allowDirectStream: false, forceTranscode: false })
  assert.equal(ht.normalize({ maxBitrateKbps: -5 }).maxBitrateKbps, 0)
  assert.equal(ht.normalize({ maxBitrateKbps: 'NaN' }).maxBitrateKbps, 0)
  assert.equal(ht.normalize({ maxBitrateKbps: 9e9 }).maxBitrateKbps, 1000000)
  assert.equal(ht.normalize({ maxBitrateKbps: 12345.6 }).maxBitrateKbps, 12346)
})

test('override: a field that is missing or null inherits; only valid values are kept', () => {
  assert.deepEqual(ht.normalizeOverride({ forceTranscode: true, allowPassthrough: null, maxBitrateKbps: null, directPlayPreferred: 'no', bogus: 1 }), { forceTranscode: true })
  assert.deepEqual(ht.normalizeOverride({ maxBitrateKbps: 0 }), { maxBitrateKbps: 0 }, '0 means "no limit for this person", which is a real override')
  assert.deepEqual(ht.normalizeOverride({ maxBitrateKbps: '' }), {})
  assert.deepEqual(ht.normalizeOverride('junk'), {})
  const server = { directPlayPreferred: true, maxBitrateKbps: 20000, allowPassthrough: true, allowDirectStream: true, forceTranscode: false }
  assert.deepEqual(ht.effective(server, { allowPassthrough: false, maxBitrateKbps: 0 }), { ...server, allowPassthrough: false, maxBitrateKbps: 0 })
  assert.deepEqual(ht.effective(server, null), server)
  assert.deepEqual(ht.overriddenFields({ allowPassthrough: false, maxBitrateKbps: 5 }).sort(), ['allowPassthrough', 'maxBitrateKbps'])
})

test('store: server settings and per-person overrides are saved separately, a null removes one field, an empty override disappears', () => {
  const store = memStore()
  const s = ht.createStore(store)
  assert.deepEqual(s.server(), ht.DEFAULTS)
  s.saveServer({ forceTranscode: true, maxBitrateKbps: 30000, nonsense: 1, directPlayPreferred: 'x' })
  assert.deepEqual(s.server(), { ...ht.DEFAULTS, forceTranscode: true, maxBitrateKbps: 30000 })
  // a person: their own limit, and forced transcode switched OFF for them only
  assert.deepEqual(s.saveUser('u1', { forceTranscode: false, maxBitrateKbps: 60000 }), { forceTranscode: false, maxBitrateKbps: 60000 })
  assert.equal(s.forUser('u1').forceTranscode, false); assert.equal(s.forUser('u1').maxBitrateKbps, 60000)
  assert.equal(s.forUser('u2').forceTranscode, true, 'someone else still gets the server value')
  assert.equal(s.forUser('').forceTranscode, true); assert.equal(s.forUser(undefined).maxBitrateKbps, 30000)
  // null removes just that field
  assert.deepEqual(s.saveUser('u1', { forceTranscode: null }), { maxBitrateKbps: 60000 })
  assert.equal(s.forUser('u1').forceTranscode, true)
  assert.deepEqual(s.saveUser('u1', { maxBitrateKbps: null }), {})
  assert.deepEqual(s.users(), {}, 'an override with nothing in it is not kept')
  assert.equal(s.saveUser('', { forceTranscode: true }), null)
  // the store survives junk
  const junk = memStore({ homeTheater: 'nonsense', homeTheaterUsers: { u9: 5, u8: { forceTranscode: true } } })
  assert.deepEqual(ht.createStore(junk).server(), ht.DEFAULTS); assert.deepEqual(ht.createStore(junk).users(), { u8: { forceTranscode: true } })
  // a store that throws is just the defaults
  assert.deepEqual(ht.createStore({ get: () => { throw new Error('x') }, set() {} }).server(), ht.DEFAULTS)
})

test('IPC: the window reads and saves the settings; users come from the accounts', async () => {
  const handlers = new Map()
  const store = memStore()
  ipc.register({ ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, store, getUsers: () => [{ id: 'a1', name: 'Nick', isAdmin: true }, { id: 'b2', username: 'kid' }, { nothing: true }] })
  const call = (n, ...a) => handlers.get(n)({}, ...a)
  let st = await call('homeTheater:get')
  assert.deepEqual(st.server, ht.DEFAULTS); assert.deepEqual(st.users.map((u) => [u.id, u.name]), [['a1', 'Nick'], ['b2', 'kid']]); assert.deepEqual(st.defaults, ht.DEFAULTS)
  st = await call('homeTheater:save', { allowPassthrough: false, maxBitrateKbps: 40000 })
  assert.equal(st.server.allowPassthrough, false); assert.equal(st.server.maxBitrateKbps, 40000)
  st = await call('homeTheater:saveUser', 'b2', { forceTranscode: true })
  assert.deepEqual(st.users.find((u) => u.id === 'b2').override, { forceTranscode: true })
  st = await call('homeTheater:saveUser', 'b2', { forceTranscode: null })
  assert.deepEqual(st.users.find((u) => u.id === 'b2').override, {})
  // and it is the same store the server reads
  assert.equal(ht.createStore(store).forUser('a1').allowPassthrough, false)
})

test('what is saved is what the decision reads: switching passthrough off turns a direct play into a direct stream for that person only', () => {
  const store = memStore()
  const s = ht.createStore(store)
  const shield = dp.resolveProfile({ client: 'androidtv', declared: { hdr: ['hdr10', 'dv:8'], audio: { aac: {}, eac3: { decode: true, passthrough: true }, truehd: { passthrough: true, atmos: true }, dtshd: { passthrough: true } }, maxAudioChannels: 8 } })
  const file = { tracks: tracksLib.parseTracks(F.withAudio(F.truehdAtmos())), ext: '.mkv' }
  const run = (uid) => decision.decide({ ...file, profile: shield, settings: s.forUser(uid) })
  assert.equal(run('a1').method, 'DirectPlay')
  s.saveUser('b2', { allowPassthrough: false })
  assert.equal(run('a1').method, 'DirectPlay'); assert.equal(run('b2').method, 'DirectStream'); assert.equal(run('b2').audio.action, 'transcode')
  s.saveServer({ allowPassthrough: false })
  assert.equal(run('a1').method, 'DirectStream')
  s.saveUser('a1', { allowPassthrough: true })
  assert.equal(run('a1').method, 'DirectPlay', 'the owner keeps passthrough for themselves')
})
