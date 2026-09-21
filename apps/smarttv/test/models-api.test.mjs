import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeMovie, normalizeShow, normalizeList, normalizeContinue, normalizeRecent, normalizeEpisodes,
  normalizePlaybackInfo, normalizePlaybackStart, normalizeNeighbour, normalizeUser, seasonLabel
} from '../app/js/util/models.js'
import { createClient, TIMEOUT_MS } from '../app/js/api.js'
import { createStore } from '../app/js/store.js'
import { parseVtt, cueAt } from '../app/js/util/vtt.js'
import { createSeeker, fraction, resumePosition } from '../app/js/util/seek.js'

const EVIL = '<img src=x onerror=alert(1)><script>alert(1)</script>'

// ---- models: everything hostile is contained -----------------------------------------------

test('normalizeMovie keeps markup as inert text and drops unsafe paths/urls', () => {
  const m = normalizeMovie({
    id: 'abc', title: EVIL, year: 1999, poster: '//evil.example/p.jpg', backdrop: 'https://evil.example/b.jpg',
    voteAverage: 7.8, overview: EVIL + '\u202E', quality: '1080p', isNew: true, stream: 'http://evil.example/x', extra: 'ignored'
  })
  assert.equal(m.title, EVIL) // inert text: the view sets textContent
  assert.equal(m.poster, null)
  assert.equal(m.backdrop, null)
  assert.equal(m.stream, null)
  assert.ok(!m.overview.includes('\u202E'))
  assert.equal(m.extra, undefined)
})

test('normalizeMovie / normalizeShow reject rows without a usable id', () => {
  assert.equal(normalizeMovie({ title: 'x' }), null)
  assert.equal(normalizeMovie({ id: '', title: 'x' }), null)
  assert.equal(normalizeMovie({ id: 'a\nb' }), null)
  assert.equal(normalizeMovie(null), null)
  assert.equal(normalizeShow({ name: 'x' }), null)
  assert.equal(normalizeShow('str'), null)
})

test('normalizeShow reads both the legacy (key,name) and the /api/v1 (id,title) shapes', () => {
  const legacy = normalizeShow({ key: 'Show (2011)', name: 'Show', poster: '/media/poster-tv/1.jpg', episodeCount: 8 })
  const v1 = normalizeShow({ id: 'Show (2011)', title: 'Show', poster: '/media/poster-tv/1.jpg', episodeCount: 8 })
  assert.deepEqual(legacy, v1)
  assert.equal(legacy.key, 'Show (2011)')
  assert.equal(legacy.title, 'Show')
})

test('normalizeList drops bad rows and caps size', () => {
  const out = normalizeList([{ id: 'a' }, null, 5, { id: 'b' }], normalizeMovie)
  assert.deepEqual(out.map((x) => x.id), ['a', 'b'])
  assert.equal(normalizeList('nope', normalizeMovie).length, 0)
  assert.equal(normalizeList(Array.from({ length: 50 }, (_, i) => ({ id: 'x' + i })), normalizeMovie, 10).length, 10)
})

test('normalizeContinue / Recent', () => {
  const c = normalizeContinue({ id: 'ep1', kind: 'tv', title: EVIL, poster: '/media/poster-tv/9.jpg', stream: '/tvfile?id=ep1&mt=SECRET', currentTime: 120, duration: 2400, percent: 5, upNext: true })
  assert.equal(c.kind, 'tv')
  assert.equal(c.currentTime, 120)
  assert.equal(c.upNext, true)
  assert.equal(normalizeContinue({ id: '' }), null)
  const tv = normalizeRecent({ kind: 'tv', id: 'ShowKey', showKey: 'ShowKey', title: 'S' })
  assert.equal(tv.key, 'ShowKey')
  const mv = normalizeRecent({ kind: 'movie', id: 'm1', title: 'M' })
  assert.equal(mv.partial, true)
  assert.equal(normalizeRecent({ kind: 'tv' }), null)
})

test('normalizeEpisodes groups seasons and sanitises titles', () => {
  const e = normalizeEpisodes({
    ok: true,
    show: { key: 'k', name: EVIL, poster: '/media/poster-tv/1.jpg', overview: 'o' },
    seasons: [
      { season: 1, episodes: [{ id: 'e1', season: 1, episode: 1, title: 'S1E1 · Pilot', watched: true, watchedPercent: 100 }, { id: '' }, null] },
      { season: null, episodes: [{ id: 'e9', title: 'Extra' }] }
    ]
  })
  assert.equal(e.show.title, EVIL)
  assert.equal(e.seasons.length, 2)
  assert.equal(e.seasons[0].episodes.length, 1)
  assert.equal(e.seasons[0].episodes[0].watched, true)
  assert.equal(e.seasons[1].season, null)
  assert.equal(seasonLabel(null), 'Other')
  assert.equal(seasonLabel(0), 'Specials')
  assert.equal(seasonLabel(3), 'Season 3')
  assert.deepEqual(normalizeEpisodes(null).seasons, [])
})

test('normalizePlaybackInfo keeps text subtitles with safe urls, drops picture subtitles', () => {
  const i = normalizePlaybackInfo({
    durationSec: 6300, video: { height: 1080 }, direct: { browser: true }, transcode: { available: true },
    qualities: [{ id: '1080p', label: '1080p' }, { id: 'evil', label: EVIL }],
    audio: [{ streamIndex: 1, label: 'English 5.1', language: 'eng', channels: 6, isDefault: true }, { label: 'no index' }],
    subtitles: [
      { key: 'side:0', kind: 'text', label: 'English', language: 'en', url: '/subtitles/file?kind=movie&id=a&i=0&mt=T' },
      { key: 'emb:3', kind: 'image', label: 'PGS', url: '' },
      { key: 'x', kind: 'text', label: 'Bad', url: 'http://evil.example/s.vtt' }
    ]
  })
  assert.equal(i.durationSec, 6300)
  assert.equal(i.audio.length, 1)
  assert.equal(i.subtitles.length, 1)
  assert.equal(i.subtitles[0].url.startsWith('/subtitles/file'), true)
  assert.deepEqual(i.qualities.map((q) => q.id), ['1080p'])
  assert.equal(i.transcodeAvailable, true)
  assert.equal(normalizePlaybackInfo(null).audio.length, 0)
})

test('normalizePlaybackStart / Neighbour / User', () => {
  assert.deepEqual(normalizePlaybackStart({ ok: true, url: '/hls/T/index.m3u8', ticket: 'T', height: 1080 }), { url: '/hls/T/index.m3u8', ticket: 'T', height: 1080 })
  assert.equal(normalizePlaybackStart({ ok: true, url: 'http://evil/x.m3u8' }), null)
  assert.equal(normalizePlaybackStart({ ok: false }), null)
  assert.equal(normalizeNeighbour({ id: 'n', kind: 'tv', title: 'Next', showKey: 'k' }).showKey, 'k')
  assert.equal(normalizeNeighbour(null), null)
  assert.equal(normalizeUser({ name: EVIL }).name, EVIL)
  assert.equal(normalizeUser(5).name, '')
})

// ---- api client with a fake XHR ------------------------------------------------------------

function fakeXHR(handler) {
  const seen = []
  class X {
    constructor() { this.headers = {}; this.status = 0; this.responseText = '' }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(k, v) { this.headers[k] = v }
    send(body) {
      seen.push(this)
      this.body = body
      const r = handler(this)
      setTimeout(() => {
        if (r === 'timeout') this.ontimeout()
        else if (r === 'error') this.onerror()
        else { this.status = r.status; this.responseText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body); this.onload() }
      }, 0)
    }
  }
  X.seen = seen
  return X
}
const mkClient = (handler, extra = {}) => {
  const XHR = fakeXHR(handler)
  let unauthorized = 0
  const client = createClient({ XHR, getOrigin: () => 'http://h:47811', getToken: () => 'SECRET-TOKEN', onUnauthorized: () => { unauthorized++ }, ...extra })
  return { client, XHR, unauthorized: () => unauthorized }
}

test('client sends the bearer token in the header only, never in the URL', async () => {
  const { client, XHR } = mkClient(() => ({ status: 200, body: { ok: true, items: [] } }))
  await client.continueWatching()
  assert.equal(XHR.seen[0].headers.Authorization, 'Bearer SECRET-TOKEN')
  assert.ok(!XHR.seen[0].url.includes('SECRET-TOKEN'))
  assert.equal(XHR.seen[0].url, 'http://h:47811/api/continue')
})

test('ping needs no token and checks the app identity', async () => {
  const { client, XHR } = mkClient(() => ({ status: 200, body: { ok: true, app: 'beeboentertainment', apiVersion: 3 } }))
  assert.deepEqual(await client.ping(), { apiVersion: 3 })
  assert.equal(XHR.seen[0].headers.Authorization, undefined)
  const other = mkClient(() => ({ status: 200, body: { ok: true, app: 'something-else' } }))
  await assert.rejects(other.client.ping(), (e) => e.kind === 'bad_response')
})

test('login posts credentials and returns the token', async () => {
  const { client, XHR } = mkClient(() => ({ status: 200, body: { ok: true, token: 'u1.123.sig', user: { name: 'Nick' } } }))
  const r = await client.login('nick', 'pw')
  assert.equal(r.token, 'u1.123.sig')
  assert.equal(r.user.name, 'Nick')
  assert.deepEqual(JSON.parse(XHR.seen[0].body), { username: 'nick', password: 'pw' })
  assert.equal(XHR.seen[0].headers.Authorization, undefined)
  const bad = mkClient(() => ({ status: 401, body: { ok: false, error: 'bad_credentials' } }))
  await assert.rejects(bad.client.login('a', 'b'), (e) => e.kind === 'unauthorized')
})

test('401 triggers onUnauthorized exactly once and rejects with a friendly error', async () => {
  const { client, unauthorized } = mkClient(() => ({ status: 401, body: { ok: false } }))
  await assert.rejects(client.continueWatching(), (e) => e.kind === 'unauthorized' && /signed in/.test(e.friendly))
  assert.equal(unauthorized(), 1)
})

test('timeouts, network errors and bad JSON map to friendly kinds', async () => {
  const t = mkClient(() => 'timeout')
  await assert.rejects(t.client.continueWatching(), (e) => e.kind === 'timeout')
  const n = mkClient(() => 'error')
  await assert.rejects(n.client.continueWatching(), (e) => e.kind === 'offline')
  const j = mkClient(() => ({ status: 200, body: '<html>not json</html>' }))
  await assert.rejects(j.client.continueWatching(), (e) => e.kind === 'bad_response')
  const s = mkClient(() => ({ status: 500, body: { message: 'boom' } }))
  await assert.rejects(s.client.continueWatching(), (e) => e.kind === 'server' && e.status === 500)
  const f = mkClient(() => ({ status: 404, body: {} }))
  await assert.rejects(f.client.episodes('k'), (e) => e.kind === 'not_found')
})

test('every request carries a timeout', async () => {
  const { client, XHR } = mkClient(() => ({ status: 200, body: { ok: true, items: [] } }))
  await client.continueWatching()
  assert.equal(XHR.seen[0].timeout, TIMEOUT_MS.normal)
  await client.moviePage()(0, 100).catch(() => {})
  assert.equal(XHR.seen[1].timeout, TIMEOUT_MS.list)
})

test('error objects never contain the token or a media token', async () => {
  const { client } = mkClient(() => ({ status: 500, body: {} }))
  await client.request('GET', 'http://h/file?id=1&mt=SECRETMT', {}).catch((e) => {
    assert.ok(!e.message.includes('SECRETMT'))
    assert.ok(!JSON.stringify(e).includes('SECRET-TOKEN'))
  })
})

test('paged library: uses /api/v1 with limit/offset and reports total', async () => {
  const { client, XHR } = mkClient((x) => ({ status: 200, body: { ok: true, total: 1300, limit: 100, offset: 100, items: [{ id: 'S1', title: 'Show 1' }] } }))
  const page = await client.showPage()(100, 100)
  assert.equal(XHR.seen[0].url, 'http://h:47811/api/v1/library/tvshows?limit=100&offset=100')
  assert.equal(page.total, 1300)
  assert.equal(page.items[0].key, 'S1')
  assert.equal(page.all, undefined)
  assert.equal(client.usingPagedApi(), true)
})

test('paged library: limit is capped at the server maximum (500)', async () => {
  const { client, XHR } = mkClient(() => ({ status: 200, body: { ok: true, total: 1, items: [{ id: 'm', title: 'M' }] } }))
  await client.moviePage({ q: 'x y' })(0, 5000)
  assert.equal(XHR.seen[0].url, 'http://h:47811/api/v1/library/movies?limit=500&offset=0&q=x%20y')
})

test('paged library: falls back to the legacy route on 404/403/405 and remembers it', async () => {
  for (const status of [404, 403, 405]) {
    const { client, XHR } = mkClient((x) => (x.url.includes('/api/v1/')
      ? { status, body: { ok: false } }
      : { status: 200, body: { ok: true, items: [{ key: 'k1', name: 'Legacy' }, { key: 'k2', name: 'Legacy 2' }] } }))
    const page = await client.showPage()(0, 100)
    assert.equal(page.all, true)
    assert.equal(page.items.length, 2)
    assert.equal(page.items[0].title, 'Legacy')
    assert.equal(client.usingPagedApi(), false)
    await client.showPage()(0, 100)
    // second call goes straight to the legacy route
    assert.ok(XHR.seen[XHR.seen.length - 1].url.includes('/api/tvshows'))
    assert.ok(!XHR.seen[XHR.seen.length - 1].url.includes('/api/v1/'))
  }
})

test('paged library: other errors (500, timeout) are not swallowed', async () => {
  const { client } = mkClient(() => ({ status: 500, body: {} }))
  await assert.rejects(client.moviePage()(0, 100), (e) => e.kind === 'server')
  assert.equal(client.usingPagedApi(), true)
})

test('paged library: an answer without total is treated as the whole list', async () => {
  const { client } = mkClient(() => ({ status: 200, body: { ok: true, items: [{ id: 'a', title: 'A' }] } }))
  const page = await client.moviePage()(0, 100)
  assert.equal(page.all, true)
})

test('playbackStart posts kind/id/quality (+audio) and playbackStop swallows errors', async () => {
  const { client, XHR } = mkClient((x) => (x.url.endsWith('/stop') ? { status: 500, body: {} } : { status: 200, body: { ok: true, url: '/hls/T/index.m3u8', ticket: 'T' } }))
  const s = await client.playbackStart('tv', 'ep1', '1080p', 2)
  assert.equal(s.url, '/hls/T/index.m3u8')
  assert.deepEqual(JSON.parse(XHR.seen[0].body), { kind: 'tv', id: 'ep1', quality: '1080p', audio: 2 })
  await client.playbackStop('T') // must not throw
  await client.progress('sess', 12, 100)
  assert.deepEqual(JSON.parse(XHR.seen[2].body), { sessionId: 'sess', currentTime: 12, duration: 100 })
  await client.progress('', 1, 1) // no session: no request
  assert.equal(XHR.seen.length, 3)
})

// ---- store ------------------------------------------------------------------------------------

test('store round-trips, survives a throwing Storage, and signOut keeps the server', () => {
  const mem = new Map()
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }
  const s = createStore(storage)
  s.setServer('http://h:47811'); s.setToken('tok'); s.setUserName('Nick'); s.setQuality('720p')
  assert.equal(s.getServer(), 'http://h:47811')
  assert.equal(s.getToken(), 'tok')
  assert.equal(s.getQuality(), '720p')
  s.signOut()
  assert.equal(s.getToken(), '')
  assert.equal(s.getUserName(), '')
  assert.equal(s.getServer(), 'http://h:47811')
  s.clearAll()
  assert.equal(s.getServer(), '')
  assert.equal(s.getQuality(), '1080p') // default
  const boom = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
  const b = createStore(boom)
  assert.equal(b.getToken(), '')
  assert.equal(b.setToken('x'), false)
  assert.equal(createStore(null).getServer(), '')
})

// ---- vtt + seek ---------------------------------------------------------------------------------

test('parseVtt: cues, tags stripped, settings dropped, SRT-style commas', () => {
  const cues = parseVtt('WEBVTT\n\nNOTE hi\n\n1\n00:00:01.000 --> 00:00:03.500 align:start\n<i>Hello</i> <b>there</b>\nsecond line\n\n00:04.000 --> 00:06,000\n' + EVIL + '\n\n')
  assert.equal(cues.length, 2)
  assert.deepEqual([cues[0].start, cues[0].end, cues[0].text], [1, 3.5, 'Hello there\nsecond line'])
  assert.equal(cues[1].start, 4)
  assert.ok(!/<\/?(i|b)>/.test(cues[0].text))
  assert.ok(!cues[1].text.includes('<img')) // tags removed entirely (and the view uses textContent anyway)
})

test('parseVtt tolerates junk', () => {
  assert.deepEqual(parseVtt(''), [])
  assert.deepEqual(parseVtt(null), [])
  assert.deepEqual(parseVtt('WEBVTT\n\ngarbage --> more garbage\ntext'), [])
  assert.deepEqual(parseVtt('WEBVTT\n\n00:05.000 --> 00:01.000\nbackwards'), [])
})

test('cueAt finds the active cue, handles seeks backwards and gaps', () => {
  const cues = parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nA\n\n00:03.000 --> 00:05.000\nB\n\n00:10.000 --> 00:12.000\nC')
  assert.equal(cueAt(cues, 0.5, 0).text, '')
  assert.equal(cueAt(cues, 1.5, 0).text, 'A')
  assert.equal(cueAt(cues, 2.5, 0).text, '')
  const b = cueAt(cues, 4, 0)
  assert.equal(b.text, 'B')
  assert.equal(cueAt(cues, 11, b.index).text, 'C')
  assert.equal(cueAt(cues, 1.5, 2).text, 'A') // hint ahead of time: user seeked back
  assert.equal(cueAt([], 1, 0).text, '')
})

test('seeker accumulates, accelerates on repeat, clamps and commits after an idle gap', () => {
  const s = createSeeker({ commitDelayMs: 600 })
  let t = 100
  let now = 0
  const dur = 3000
  t = s.press(1, 100, dur, now); assert.equal(t, 110)
  now += 200; t = s.press(1, 100, dur, now); assert.equal(t, 120)
  now += 200; t = s.press(1, 100, dur, now); assert.equal(t, 130)
  now += 200; t = s.press(1, 100, dur, now); assert.equal(t, 160) // accelerates to 30 s
  assert.equal(s.displayTime(100), 160)
  assert.equal(s.due(now + 100), false)
  assert.equal(s.due(now + 600), true)
  assert.equal(s.commit(), 160)
  assert.equal(s.pending(), null)
  assert.equal(s.displayTime(100), 100)
  // direction change restarts the streak; clamps to [0, duration-1]
  now += 5000
  assert.equal(s.press(-1, 5, dur, now), 0)
  s.cancel()
  assert.equal(s.press(1, 2995, dur, now + 1), 2999)
})

test('fraction and resumePosition', () => {
  assert.equal(fraction(50, 100), 0.5)
  assert.equal(fraction(5, 0), 0)
  assert.equal(fraction(500, 100), 1)
  assert.equal(resumePosition(10, 6000), 0) // barely started
  assert.equal(resumePosition(1200, 6000), 1200)
  assert.equal(resumePosition(5950, 6000), 0) // basically finished
  assert.equal(resumePosition(0, 0), 0)
  assert.equal(resumePosition(600, 0), 600) // unknown duration
})
