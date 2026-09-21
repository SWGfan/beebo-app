import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePreroll, seenBody, PREROLL_PATH, SEEN_PATH, MAX_ITEMS } from '../app/js/util/preroll.js'
import { createClient } from '../app/js/api.js'

// Cinema Mode pre-show (docs CINEMA-MODE.md): only the owner's local files are played on the TV; YouTube items never are.

const HEX = '0123456789abcdef0123'
const local = (o) => ({ type: 'local', role: 'trailer', url: `/cinema/media/${HEX}?mt=1790000000000.abcDEF_-123`, title: 'Alpha (2019)', durationSec: 92, key: 'l:abc123', titleKey: 't:m1', ...o })
const yt = { type: 'youtube', role: 'trailer', videoId: 'AbCdEfGhI01', title: 'Online', key: 'y:AbCdEfGhI01' }

test('paths are the documented ones', () => {
  assert.equal(PREROLL_PATH, '/api/playback/preroll')
  assert.equal(SEEN_PATH, '/api/playback/preroll/seen')
})

test('only local items with a signed /cinema/media address are kept, in order; YouTube is never played', () => {
  const items = normalizePreroll({ ok: true, enabled: true, items: [local({ role: 'intro', key: 'i:feature', title: 'Feature Presentation' }), yt, local()] })
  assert.equal(items.length, 2)
  assert.equal(items[0].role, 'intro')
  assert.equal(items[1].title, 'Alpha (2019)')
  assert.equal(items[1].titleKey, 't:m1')
})

test('nothing to play when the feature is off, for a guest, or on any odd answer', () => {
  assert.deepEqual(normalizePreroll({ ok: true, enabled: false, reason: 'disabled', items: [] }), [])
  assert.deepEqual(normalizePreroll({ ok: true, enabled: false, reason: 'resuming', items: [local()] }), [])
  assert.deepEqual(normalizePreroll(null), [])
  assert.deepEqual(normalizePreroll({}), [])
  assert.deepEqual(normalizePreroll({ ok: true, enabled: true, items: 'x' }), [])
  assert.deepEqual(normalizePreroll({ ok: false, enabled: true, items: [local()] }), [])
})

test('a hostile address is dropped, keys that do not look like keys are blanked, and the list is capped', () => {
  const bad = [
    local({ url: 'http://evil.example/a.mp4' }), local({ url: '//evil.example/a.mp4' }),
    local({ url: '/cinema/media/../../api/admin?mt=x' }), local({ url: `/cinema/media/${HEX}` }),
    local({ url: `/cinema/media/${HEX}?mt=x&y=<script>` }), local({ url: `/cinema/media/NOTHEX?mt=x` }),
    local({ url: `/other/${HEX}?mt=abc` })
  ]
  assert.deepEqual(normalizePreroll({ ok: true, enabled: true, items: bad }), [])
  const odd = normalizePreroll({ ok: true, enabled: true, items: [local({ key: 'not a key', titleKey: '../x', title: '<b>x</b>' })] })
  assert.equal(odd[0].key, '')
  assert.equal(odd[0].titleKey, '')
  assert.equal(odd[0].title, '<b>x</b>') // inert text; the player uses textContent
  const many = normalizePreroll({ ok: true, enabled: true, items: Array.from({ length: 30 }, () => local()) })
  assert.equal(many.length, MAX_ITEMS)
})

test('seen: the intro is never reported, a trailer with its title key is', () => {
  assert.equal(seenBody({ key: 'i:feature' }), null)
  assert.equal(seenBody({ key: '' }), null)
  assert.equal(seenBody(null), null)
  assert.deepEqual(seenBody({ key: 'l:abc', titleKey: 't:m1' }), { items: [{ key: 'l:abc', titleKey: 't:m1' }] })
  assert.deepEqual(seenBody({ key: 'l:abc', titleKey: '' }), { items: [{ key: 'l:abc' }] })
})

function fakeXHR(handler) {
  const seen = []
  class X {
    constructor() { this.headers = {}; this.status = 0; this.responseText = '' }
    open(m, u) { this.method = m; this.url = u }
    setRequestHeader(k, v) { this.headers[k] = v }
    send(b) { seen.push(this); this.body = b; const r = handler(this); setTimeout(() => { this.status = r.status; this.responseText = JSON.stringify(r.body); this.onload() }, 0) }
  }
  X.seen = seen
  return X
}

test('client.preroll asks for the film with the bearer token, never rejects, and reports what started', async () => {
  const XHR = fakeXHR((x) => (x.method === 'GET' ? { status: 200, body: { ok: true, enabled: true, items: [local()] } } : { status: 200, body: { ok: true, recorded: 2 } }))
  const client = createClient({ XHR, getOrigin: () => 'http://h:47811', getToken: () => 'TOK' })
  const items = await client.preroll('movie-id')
  assert.equal(items.length, 1)
  assert.equal(XHR.seen[0].url, 'http://h:47811/api/playback/preroll?id=movie-id&kind=movie')
  assert.equal(XHR.seen[0].headers.Authorization, 'Bearer TOK')
  await client.prerollSeen(items[0])
  assert.equal(XHR.seen[1].method, 'POST')
  assert.deepEqual(JSON.parse(XHR.seen[1].body), { items: [{ key: 'l:abc123', titleKey: 't:m1' }] })
  await client.prerollSeen({ key: 'i:feature' }) // nothing sent for the intro
  assert.equal(XHR.seen.length, 2)
  // an older server (404), or a broken one, is simply "no pre-show"
  const old = createClient({ XHR: fakeXHR(() => ({ status: 404, body: { ok: false } })), getOrigin: () => 'http://h', getToken: () => 't' })
  assert.deepEqual(await old.preroll('x'), [])
  const boom = createClient({ XHR: fakeXHR(() => ({ status: 500, body: {} })), getOrigin: () => 'http://h', getToken: () => 't' })
  assert.deepEqual(await boom.preroll('x'), [])
})
