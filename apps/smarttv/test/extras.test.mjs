import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extraRoutes, normalizeLiveStatus, normalizeChannels, normalizeLiveWatch, explainLiveFailure,
  normalizeBook, normalizeBookShelf, normalizeBookDetail, locatePart,
  normalizeEpisode, normalizeEpisodeShelf, normalizeStation, normalizeStationShelf, normalizeRadioSession, nowPlaying, radioLine
} from '../app/js/util/extras.js'
import { createClient } from '../app/js/api.js'
import { buildUrl } from '../app/js/util/urls.js'

// Live TV, Audiobooks, Podcasts, Radio rows (docs LIVE-TV.md, AUDIOBOOKS.md, PODCASTS-AND-RADIO.md): route shapes, hostile
// replies, and "hidden when the server lacks the feature".

const EVIL = '<img src=x onerror=alert(1)>'
const BOOK = 'a1b2c3d4e5f60718'
const EP = '0123456789ab.0123456789abcdef'

test('routes are the documented bearer JSON routes, with the media-token flag where audio is played', () => {
  assert.equal(buildUrl('http://h', extraRoutes.liveStatus().path), 'http://h/api/livetv/status')
  assert.equal(extraRoutes.liveWatch().path, '/api/livetv/watch')
  assert.equal(extraRoutes.book(BOOK).path, '/api/audiobooks/book/' + BOOK)
  assert.equal(extraRoutes.book(BOOK).query.tokens, 1)
  assert.equal(extraRoutes.bookProgress(BOOK).path, '/api/audiobooks/book/' + BOOK + '/progress')
  assert.equal(extraRoutes.podcastLatest().query.tokens, 1)
  assert.equal(extraRoutes.podcastContinue().query.tokens, 1)
  assert.equal(extraRoutes.podcastProgress(EP).path, '/api/podcasts/episode/' + EP + '/progress')
  assert.equal(extraRoutes.radioPlay().query.tokens, 1)
  assert.equal(extraRoutes.radioSession('abc').path, '/api/radio/session/abc')
  // nothing here can carry a token or an admin path
  for (const r of Object.values(extraRoutes)) {
    const route = r('x')
    assert.ok(!/admin|rescan|settings|lookup/.test(route.path), route.path)
  }
})

test('live status: available only when on, with a channel', () => {
  assert.deepEqual(normalizeLiveStatus({ ok: true, enabled: true, channelCount: 12 }), { available: true, channelCount: 12 })
  assert.equal(normalizeLiveStatus({ ok: true, enabled: false, channelCount: 12 }).available, false)
  assert.equal(normalizeLiveStatus({ ok: true, enabled: true, channelCount: 0 }).available, false)
  assert.equal(normalizeLiveStatus(null).available, false)
  assert.equal(normalizeLiveStatus({ ok: false, enabled: true, channelCount: 3 }).available, false)
})

test('channels are cut to safe text and drop rows without a usable key', () => {
  const list = normalizeChannels({ channels: [
    { key: 'hd-1', number: '5.1', name: EVIL, hd: true, favourite: true, now: { title: 'News', start: 1, stop: 2 }, next: { title: 'Sport' } },
    { key: 'bad key with spaces', name: 'x' }, { name: 'no key' }, null, 5
  ] })
  assert.equal(list.length, 1)
  assert.equal(list[0].name, EVIL) // inert text: views use textContent
  assert.equal(list[0].now.title, 'News')
  assert.equal(list[0].hd, true)
  assert.deepEqual(normalizeChannels(null), [])
})

test('live watch: only the server\'s own live playlist is followed', () => {
  const ok = normalizeLiveWatch({ ok: true, url: '/livetv/hls/T1.abc/index.m3u8', ticket: 'T1.abc', channel: { key: 'ch1', number: '5', name: 'Five' }, now: { title: 'X' }, timeshiftMinutes: 90 })
  assert.equal(ok.url, '/livetv/hls/T1.abc/index.m3u8')
  assert.equal(ok.channelKey, 'ch1')
  assert.equal(ok.timeshiftMinutes, 90)
  for (const bad of [
    null, {}, { ok: false, url: '/livetv/hls/T/index.m3u8' },
    { ok: true, url: 'http://evil.example/livetv/hls/T/index.m3u8' },
    { ok: true, url: '//evil.example/x' },
    { ok: true, url: '/hls/T/index.m3u8' },
    { ok: true, url: '/livetv/hls/T/evil.php' },
    { ok: true, url: '/livetv/hls/../api/admin/index.m3u8' }
  ]) assert.equal(normalizeLiveWatch(bad), null, JSON.stringify(bad))
})

test('busy tuner and other failures are said in plain words', () => {
  assert.match(explainLiveFailure({ status: 503, body: { error: 'tuners_busy', message: 'x' } }), /tuner/i)
  assert.equal(explainLiveFailure({ status: 409, body: { message: 'Live TV is turned off.' } }), 'Live TV is turned off.')
  assert.match(explainLiveFailure({ status: 403 }), /not available/)
  assert.equal(explainLiveFailure(null), 'Live TV could not start.')
})

test('books: ids are the server\'s 16 hex, covers only /api/audiobooks/cover/<hash>', () => {
  const b = normalizeBook({ id: BOOK, title: EVIL, author: 'A', cover: '/api/audiobooks/cover/abc_DEF-1', duration: 3600, progress: { position: 900, finished: false } })
  assert.equal(b.id, BOOK)
  assert.equal(b.cover, '/api/audiobooks/cover/abc_DEF-1')
  assert.equal(b.position, 900)
  assert.equal(normalizeBook({ id: BOOK, cover: 'http://evil/x.jpg' }).cover, null)
  assert.equal(normalizeBook({ id: BOOK, cover: '/api/admin/x' }).cover, null)
  assert.equal(normalizeBook({ id: '../etc' }), null)
  assert.equal(normalizeBook({ title: 'x' }), null)
})

test('the book shelf: continue first, then up-next, then unfinished books, each once', () => {
  const other = 'b2c3d4e5f6071829'
  const third = 'c3d4e5f607182930'
  const shelf = normalizeBookShelf(
    { items: [{ book: { id: BOOK, title: 'One' }, progress: { position: 10 } }], nextUp: [{ book: { id: other, title: 'Two' } }] },
    { items: [{ id: BOOK, title: 'One again' }, { id: third, title: 'Three', status: 'unstarted' }, { id: 'd4e5f60718293041', title: 'Done', progress: { finished: true } }] }
  )
  assert.deepEqual(shelf.map((b) => b.title), ['One', 'Two', 'Three'])
  assert.equal(shelf[0].position, 10)
  assert.deepEqual(normalizeBookShelf(null, null), [])
})

test('book detail: only stream addresses of this server\'s book routes, chapters and resume position', () => {
  const d = normalizeBookDetail({
    ok: true,
    book: {
      id: BOOK, title: 'T', duration: 3000,
      parts: [
        { index: 0, start: 0, duration: 1000, stream: `/api/audiobooks/book/${BOOK}/stream/0?mt=TOK` },
        { index: 1, start: 1000, duration: 2000, stream: `/api/audiobooks/book/${BOOK}/stream/1?mt=TOK` },
        { index: 2, start: 3000, duration: 1, stream: 'http://evil.example/a.mp3' },
        { index: 3, start: 3001, duration: 1, stream: '/api/admin/x' }
      ],
      chapters: [{ title: 'Intro', start: 0, end: 500 }, { title: EVIL, start: 500, end: 3000 }]
    },
    progress: { position: 1500, finished: false }, speed: 1.25
  })
  assert.equal(d.parts.length, 2)
  assert.equal(d.chapters.length, 2)
  assert.equal(d.position, 1500)
  assert.equal(d.speed, 1.25)
  assert.equal(normalizeBookDetail({ ok: true, book: { id: BOOK, parts: [{ stream: 'http://evil/x' }] } }), null)
  assert.equal(normalizeBookDetail({ ok: false }), null)
  assert.equal(normalizeBookDetail(null), null)
  // a finished book starts again from the top
  assert.equal(normalizeBookDetail({ ok: true, book: { id: BOOK, duration: 10, parts: [{ index: 0, start: 0, duration: 10, stream: `/api/audiobooks/book/${BOOK}/stream/0` }] }, progress: { position: 10, finished: true } }).position, 0)
})

test('locatePart maps a whole-book position onto a file and an offset', () => {
  const parts = [{ start: 0, duration: 1000 }, { start: 1000, duration: 2000 }, { start: 3000, duration: 500 }]
  assert.deepEqual(locatePart(parts, 0), { index: 0, offset: 0 })
  assert.deepEqual(locatePart(parts, 999.5), { index: 0, offset: 999.5 })
  assert.deepEqual(locatePart(parts, 1000), { index: 1, offset: 0 })
  assert.deepEqual(locatePart(parts, 3200), { index: 2, offset: 200 })
  assert.deepEqual(locatePart(parts, -5), { index: 0, offset: 0 })
  assert.deepEqual(locatePart(parts, 99999), { index: 2, offset: 96999 })
})

test('podcast episodes: the key and the stream address must belong together', () => {
  const e = normalizeEpisode({ key: EP, title: EVIL, feedTitle: 'Show', durationSec: 1800, progressSec: 60, played: false, stream: `/api/podcasts/episode/${EP}/stream?mt=TOK` })
  assert.equal(e.key, EP)
  assert.equal(e.stream, `/api/podcasts/episode/${EP}/stream?mt=TOK`)
  assert.equal(e.position, 60)
  assert.equal(normalizeEpisode({ key: EP, stream: '/api/podcasts/episode/ffffffffffff.ffffffffffffffff/stream' }), null)
  assert.equal(normalizeEpisode({ key: EP, stream: 'http://evil.example/a.mp3' }), null)
  assert.equal(normalizeEpisode({ key: 'nope', stream: '/api/podcasts/episode/nope/stream' }), null)
  assert.equal(normalizeEpisode(null), null)
})

test('the episode shelf: started episodes first, then unplayed newest ones, each once', () => {
  const ep2 = '111111111111.1111111111111111'
  const ep3 = '222222222222.2222222222222222'
  const mk = (key, o) => ({ key, title: key, stream: `/api/podcasts/episode/${key}/stream?mt=T`, ...o })
  const shelf = normalizeEpisodeShelf({ episodes: [mk(EP, { progressSec: 30 })] }, { episodes: [mk(EP), mk(ep2, { played: true }), mk(ep3)] })
  assert.deepEqual(shelf.map((e) => e.key), [EP, ep3])
})

test('radio stations and the session', () => {
  const id = 'rb:01234567-89ab-cdef-0123-456789abcdef'
  const s = normalizeStation({ id, name: EVIL, country: 'Canada', tags: ['news'] })
  assert.equal(s.id, id)
  assert.equal(s.sub, 'Canada')
  assert.equal(normalizeStation({ id: 'rb:../..', name: 'x' }), null)
  assert.equal(normalizeStation({ id: 'c:0123456789ab', name: 'Mine', tags: ['jazz'] }).sub, 'jazz')
  // popular stations are used only when nothing is saved
  const popular = { stations: [{ id, name: 'Pop' }] }
  assert.deepEqual(normalizeStationShelf({ favorites: [] }, { recent: [] }, popular).map((x) => x.title), ['Pop'])
  assert.deepEqual(normalizeStationShelf({ favorites: [{ id, name: 'Fav' }] }, { recent: [{ id, name: 'Dup' }] }, popular).map((x) => x.title), ['Fav'])
  const sess = normalizeRadioSession({ ok: true, session: { id: 'abc123_-XY', station: { name: 'Jazz FM' }, stream: '/api/radio/session/abc123_-XY/stream?mt=T', nowPlaying: { artist: 'A', title: 'B' } } })
  assert.equal(sess.name, 'Jazz FM')
  assert.equal(sess.nowPlaying, 'A - B')
  assert.equal(normalizeRadioSession({ session: { id: 'abc123_-XY', stream: '/api/radio/session/other/stream' } }), null)
  assert.equal(normalizeRadioSession({ session: { id: 'abc123_-XY', stream: 'http://evil.example/s.mp3' } }), null)
  assert.equal(normalizeRadioSession(null), null)
  assert.equal(nowPlaying({ nowPlaying: { raw: 'Only Raw' } }), 'Only Raw')
  assert.equal(nowPlaying({}), '')
  assert.equal(radioLine({ session: { state: 'reconnecting' } }), 'Reconnecting…')
  assert.equal(radioLine(null), '')
})

// ---- the client: rows hide when the server lacks the feature -------------------------------------------------------------------

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
      setTimeout(() => { this.status = r.status; this.responseText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body); this.onload() }, 0)
    }
  }
  X.seen = seen
  return X
}
const mk = (handler) => {
  const XHR = fakeXHR(handler)
  return { client: createClient({ XHR, getOrigin: () => 'http://h:47811', getToken: () => 'TOK' }), XHR }
}

test('an older server (404 everywhere) gives empty shelves and no error: the rows stay hidden', async () => {
  const { client } = mk(() => ({ status: 404, body: { ok: false, error: 'not_found' } }))
  assert.deepEqual(await client.liveRow(), [])
  assert.deepEqual(await client.bookShelf(), [])
  assert.deepEqual(await client.podcastShelf(), [])
  assert.deepEqual(await client.radioShelf(), [])
})

test('Live TV off, or restricted profile: no row', async () => {
  const off = mk((x) => ({ status: 200, body: { ok: true, enabled: false, channelCount: 4 } }))
  assert.deepEqual(await off.client.liveRow(), [])
  assert.equal(off.XHR.seen.length, 1, 'the channel list is not even asked for')
  const restricted = mk(() => ({ status: 403, body: { ok: false, error: 'restricted' } }))
  assert.deepEqual(await restricted.client.liveRow(), [])
})

test('Live TV on: status, then the channel list, both with the bearer header only', async () => {
  const { client, XHR } = mk((x) => x.url.endsWith('/status')
    ? { status: 200, body: { ok: true, enabled: true, channelCount: 2 } }
    : { status: 200, body: { ok: true, channels: [{ key: 'a', name: 'A', number: '2' }, { key: 'b', name: 'B', number: '4' }] } })
  const rows = await client.liveRow()
  assert.deepEqual(rows.map((c) => c.key), ['a', 'b'])
  for (const x of XHR.seen) { assert.equal(x.headers.Authorization, 'Bearer TOK'); assert.ok(!x.url.includes('TOK')) }
  assert.equal(XHR.seen[0].url, 'http://h:47811/api/livetv/status')
})

test('audiobook shelf and detail use tokens=1; progress is a POST with the newest-listen stamp', async () => {
  const { client, XHR } = mk((x) => {
    if (x.url.includes('/continue')) return { status: 200, body: { ok: true, items: [{ book: { id: BOOK, title: 'One' }, progress: { position: 5 } }], nextUp: [] } }
    if (x.url.includes('/books')) return { status: 200, body: { ok: true, items: [] } }
    if (x.method === 'POST') return { status: 200, body: { ok: true, applied: true } }
    return { status: 200, body: { ok: true, book: { id: BOOK, title: 'One', duration: 100, parts: [{ index: 0, start: 0, duration: 100, stream: `/api/audiobooks/book/${BOOK}/stream/0?mt=T` }], chapters: [] }, progress: null, speed: 1 } }
  })
  assert.equal((await client.bookShelf())[0].title, 'One')
  const d = await client.bookDetail(BOOK)
  assert.equal(d.parts.length, 1)
  assert.ok(XHR.seen.some((x) => x.url.includes('tokens=1') && x.url.includes('/api/audiobooks/book/')))
  await client.saveBookProgress(BOOK, 42.9)
  const post = XHR.seen[XHR.seen.length - 1]
  assert.equal(post.method, 'POST')
  assert.equal(post.url, `http://h:47811/api/audiobooks/book/${BOOK}/progress`)
  const body = JSON.parse(post.body)
  assert.equal(body.position, 42)
  assert.ok(body.updatedAt > 1e12)
})

test('podcast progress and radio play', async () => {
  const { client, XHR } = mk((x) => x.url.includes('/radio/play')
    ? { status: 201, body: { ok: true, session: { id: 'sess_1', station: { name: 'S' }, stream: '/api/radio/session/sess_1/stream?mt=T' } } }
    : { status: 200, body: { ok: true } })
  await client.savePodcastProgress(EP, 12.7, 1800.2)
  assert.deepEqual(JSON.parse(XHR.seen[0].body), { position: 12, duration: 1800 })
  const s = await client.radioPlay('rb:01234567-89ab-cdef-0123-456789abcdef')
  assert.equal(s.stream, '/api/radio/session/sess_1/stream?mt=T')
  assert.ok(XHR.seen[1].url.includes('/api/radio/play?tokens=1'))
})

test('an unexpected radio play answer is refused', async () => {
  const { client } = mk(() => ({ status: 200, body: { ok: true, session: { id: 'x', stream: 'http://evil/x' } } }))
  await assert.rejects(client.radioPlay('rb:01234567-89ab-cdef-0123-456789abcdef'), (e) => e.kind === 'bad_response')
})
