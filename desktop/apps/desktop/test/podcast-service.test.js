// The Podcasts service on fake network answers and a temp folder: subscribing, background refresh
// with conditional GET and back-off, per-person listening state, the queue, auto-download and the
// capped download folder, OPML, search, chapters, skip-silence, and removal with the account.
// No live network. Run: node --test test/podcast-service.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const { createPodcasts, clampSpeed, silenceArgs } = localRequire('./electron/podcastService')
const feedLib = localRequire('./electron/podcastFeed')
const { FetchError } = localRequire('./electron/outboundFetch')

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'podcasts', name))
const FEED_URL = 'https://example.test/feed.xml'
const FEED_ID = feedLib.feedIdFor(FEED_URL)

function memoryStore() {
  const data = {}
  return { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
}

// A fake outboundFetch: routes[url] is { status, headers, body } or a function (headers, callNo) returning one (or throwing).
function fakeNet(routes) {
  const calls = []
  const answer = (url, headers) => {
    const n = calls.filter((c) => c.url === url).length
    calls.push({ url, headers: headers || {} })
    // Episode audio is served by default (1000 bytes of "audio"); a test overrides one by adding its address.
    const r = routes[url] || (url.startsWith('https://cdn.example.test/') ? { headers: { 'content-type': 'audio/mpeg' }, size: 1000 } : null)
    if (!r) throw new FetchError('unresolvable')
    return typeof r === 'function' ? r(headers || {}, n) : r
  }
  return {
    calls,
    routes,
    async get(url, o) {
      const r = answer(url, o && o.headers)
      return { status: r.status || 200, headers: r.headers || {}, body: Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body || '')), url }
    },
    async download(url, file, o) {
      const r = answer(url, o && o.headers)
      if (r.status && r.status !== 200) throw new FetchError('http_status', String(r.status))
      if (o && o.accept && !o.accept(r.headers || { 'content-type': 'audio/mpeg' })) throw new FetchError('wrong_type')
      const size = r.size || 1000
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, r.body ? Buffer.from(r.body) : Buffer.alloc(size, 9))
      return { size: fs.statSync(file).size, headers: r.headers || {}, url }
    },
    async open(url, o) {
      const r = answer(url, o && o.headers)
      const { Readable } = require('node:stream')
      return { status: r.status || 200, headers: r.headers || { 'content-type': 'audio/mpeg' }, stream: Readable.from([Buffer.from(r.body || 'audio')]), url, close() {} }
    }
  }
}

function rss(items, title = 'Show') {
  const body = items.map((i) => `<item><title>${i.title}</title><guid>${i.guid}</guid><pubDate>${new Date(i.at).toUTCString()}</pubDate><enclosure url="${i.url || 'https://cdn.example.test/' + i.guid + '.mp3'}" length="${i.size || 1000}" type="audio/mpeg"/>${i.extra || ''}</item>`).join('')
  return `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>${title}</title>${body}</channel></rss>`
}
const DAY = 86400000
const T0 = Date.UTC(2024, 0, 1)
const eps = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ title: `Ep ${start + i + 1}`, guid: `g${start + i + 1}`, at: T0 + (start + i) * DAY }))

async function setup(routes, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-pod-'))
  const store = memoryStore()
  if (opts.settings) store.set('podcastSettings', opts.settings)
  const clock = { t: Date.UTC(2024, 5, 1) }
  const net = fakeNet(routes)
  const mk = () => createPodcasts({ store, dir, fetcher: net, now: () => clock.t, log: () => {}, ...(opts.extra || {}) })
  const svc = mk()
  const cleanup = () => { fs.rmSync(dir, { recursive: true, force: true }) }
  return { dir, store, clock, net, svc, mk, cleanup }
}
const keyOf = (feedId, guid) => `${feedId}.${feedLib.episodeIdFor(guid)}`

test('subscribe by RSS address: fetched once, shared, per-person, and a bad address saves nothing', async () => {
  const t = await setup({ [FEED_URL]: { headers: { etag: '"a"' }, body: rss(eps(3), 'Shared Show') }, 'https://example.test/html': { body: '<html>not a feed</html>' } })
  try {
    const a = await t.svc.subscribe('alice', FEED_URL)
    assert.equal(a.id, FEED_ID)
    assert.equal(a.title, 'Shared Show')
    assert.equal(a.episodeCount, 3)
    assert.equal(a.unplayed, 3)
    assert.equal(a.subscribed, true)
    const b = await t.svc.subscribe('bob', 'HTTPS://Example.test/feed.xml#x')
    assert.equal(b.id, FEED_ID, 'the same show however it was typed')
    assert.equal(t.net.calls.filter((c) => c.url === FEED_URL).length, 1, 'fetched once for two subscribers')
    assert.deepEqual(t.svc.subscriptions('alice').map((s) => s.id), [FEED_ID])
    assert.deepEqual(t.svc.subscriptions('carol'), [])
    await assert.rejects(t.svc.subscribe('alice', 'https://example.test/html'), { code: 'not_a_podcast_feed' })
    await assert.rejects(t.svc.subscribe('alice', 'file:///etc/passwd'), { code: 'bad_url' })
    await assert.rejects(t.svc.subscribe('alice', 'https://example.test/gone'), { code: 'unresolvable' })
    assert.equal(Object.keys(t.svc._state.feeds).length, 1, 'nothing saved for the failures')
  } finally { t.cleanup() }
})

test('per-person state is private: progress, played, queue, prefs; and you must follow a show to touch it', async () => {
  const t = await setup({ [FEED_URL]: { body: rss(eps(4)) } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    await t.svc.subscribe('bob', FEED_URL)
    const e1 = keyOf(FEED_ID, 'g1')
    const e2 = keyOf(FEED_ID, 'g2')
    const e3 = keyOf(FEED_ID, 'g3')
    // halfway through a 2-hour episode
    t.svc.setProgress('alice', e1, 1800, 7200)
    assert.equal(t.svc.episodes('alice', FEED_ID).episodes.find((x) => x.key === e1).progressSec, 1800)
    assert.equal(t.svc.episodes('bob', FEED_ID).episodes.find((x) => x.key === e1).progressSec, 0, "bob does not see alice's place")
    assert.deepEqual(t.svc.inProgress('alice').map((x) => x.key), [e1])
    assert.deepEqual(t.svc.inProgress('bob'), [])
    // within 30s of the end = finished, and it leaves the queue
    t.svc.queueAdd('alice', e1)
    t.svc.setProgress('alice', e1, 7180, 7200)
    const done = t.svc.episodes('alice', FEED_ID).episodes.find((x) => x.key === e1)
    assert.equal(done.played, true)
    assert.equal(done.progressSec, 0)
    assert.deepEqual(t.svc.queueList('alice'), [])
    assert.equal(t.svc.episodes('alice', FEED_ID).feed.unplayed, 3)
    assert.equal(t.svc.episodes('bob', FEED_ID).feed.unplayed, 4)
    assert.equal(t.svc.episodes('alice', FEED_ID, { unplayed: true }).total, 3)
    // mark played / unplayed by hand
    t.svc.markPlayed('alice', e2, true)
    assert.equal(t.svc.episodes('alice', FEED_ID, { unplayed: true }).total, 2)
    t.svc.markPlayed('alice', e2, false)
    assert.equal(t.svc.episodes('alice', FEED_ID, { unplayed: true }).total, 3)
    // queue: add, next, position, reorder, remove, clear; never someone else's
    t.svc.queueAdd('alice', e2)
    t.svc.queueAdd('alice', e3)
    t.svc.queueAdd('alice', e1, { next: true })
    assert.deepEqual(t.svc.queueList('alice').map((x) => x.key), [e1, e2, e3])
    assert.deepEqual(t.svc.queueReorder('alice', [e3, e1, 'bogus', e3]).map((x) => x.key), [e3, e1, e2])
    assert.deepEqual(t.svc.queueRemove('alice', e1).map((x) => x.key), [e3, e2])
    assert.deepEqual(t.svc.queueList('bob'), [])
    assert.deepEqual(t.svc.queueClear('alice'), [])
    // latest: across everything they follow, newest first
    assert.equal(t.svc.latest('bob')[0].title, 'Ep 4')
    // not following -> refused, whatever the key
    assert.throws(() => t.svc.setProgress('mallory', e1, 5, 100), { code: 'not_subscribed' })
    assert.throws(() => t.svc.queueAdd('mallory', e1), { code: 'not_subscribed' })
    assert.throws(() => t.svc.episodes('mallory', FEED_ID), { code: 'not_subscribed' })
    assert.throws(() => t.svc.setProgress('alice', 'zzzzzzzzzzzz.zzzzzzzzzzzzzzzz', 5, 100), { code: 'not_found' })
    assert.throws(() => t.svc.setProgress('alice', '../../etc/passwd', 5, 100), { code: 'not_found' })
    assert.throws(() => t.svc.setProgress(null, e1, 5, 100), { code: 'unauthorized' })
  } finally { t.cleanup() }
})

test('speed and skip-silence preferences: 0.5x to 3x in 0.05 steps, per show override', async () => {
  assert.equal(clampSpeed(1.5), 1.5)
  assert.equal(clampSpeed(0.1), 0.5)
  assert.equal(clampSpeed(9), 3)
  assert.equal(clampSpeed(1.23), 1.25)
  assert.equal(clampSpeed('abc', 1), 1)
  assert.equal(clampSpeed(NaN, 2), 2)
  const t = await setup({ [FEED_URL]: { body: rss(eps(1)) } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    assert.deepEqual(t.svc.getPrefs('alice'), { speed: 1, skipSilence: false, speedByFeed: {} })
    assert.equal(t.svc.setPrefs('alice', { speed: 2.4 }).speed, 2.4)
    assert.equal(t.svc.setPrefs('alice', { speed: 99 }).speed, 3)
    assert.equal(t.svc.setPrefs('alice', { skipSilence: true }).skipSilence, true)
    assert.deepEqual(t.svc.setPrefs('alice', { feedId: FEED_ID, feedSpeed: 1.35 }).speedByFeed, { [FEED_ID]: 1.35 })
    assert.throws(() => t.svc.setPrefs('alice', { feedId: '../x', feedSpeed: 2 }), { code: 'bad_feed' })
    assert.deepEqual(t.svc.setPrefs('alice', { feedId: FEED_ID, feedSpeed: null }).speedByFeed, {})
    assert.equal(t.svc.getPrefs('bob').speed, 1, 'nobody else is affected')
  } finally { t.cleanup() }
})

test('background refresh: conditional GET (ETag / Last-Modified), unchanged and changed feeds, back-off and recovery', async () => {
  let version = 1
  const routes = {
    [FEED_URL]: (h) => {
      if (h['If-None-Match'] === `"v${version}"`) return { status: 304 }
      return { headers: { etag: `"v${version}"`, 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }, body: rss(eps(version === 1 ? 2 : 3)) }
    }
  }
  const t = await setup(routes)
  try {
    await t.svc.subscribe('alice', FEED_URL)
    // not due yet: nothing happens
    assert.equal((await t.svc.tick()).refreshed, 0)
    // due, unchanged: sends the validators, 304 costs nothing
    t.clock.t += 2 * 3600000
    assert.equal((await t.svc.tick()).refreshed, 1)
    const last = t.net.calls[t.net.calls.length - 1]
    assert.equal(last.headers['If-None-Match'], '"v1"')
    assert.equal(last.headers['If-Modified-Since'], 'Mon, 01 Jan 2024 00:00:00 GMT')
    assert.equal(t.svc.subscriptions('alice')[0].episodeCount, 2)
    // the publisher posts an episode
    version = 2
    t.clock.t += 2 * 3600000
    await t.svc.tick()
    assert.equal(t.svc.subscriptions('alice')[0].episodeCount, 3)
    assert.equal(t.svc.subscriptions('alice')[0].unplayed, 3)
    // the server goes down: recorded, backed off (not retried a minute later), and healed on recovery
    routes[FEED_URL] = () => ({ status: 503, body: 'down' })
    t.clock.t += 2 * 3600000
    await t.svc.tick()
    let s = t.svc.subscriptions('alice')[0]
    assert.equal(s.error, 'http_503')
    assert.equal(s.episodeCount, 3, 'the episodes already known stay')
    const callsBefore = t.net.calls.length
    t.clock.t += 60000
    await t.svc.tick()
    assert.equal(t.net.calls.length, callsBefore, 'backed off: not retried a minute later')
    routes[FEED_URL] = () => ({ headers: { etag: '"v2"' }, body: rss(eps(3)) })
    t.clock.t += 30 * 3600000
    await t.svc.tick()
    s = t.svc.subscriptions('alice')[0]
    assert.equal(s.error, '')
    // identical body with no validators is recognised by its hash and not re-parsed
    assert.deepEqual(await t.svc.refreshFeed(FEED_ID), { ok: true, changed: false, newEpisodes: 0 })
    // a show nobody follows is never fetched
    await t.svc.unsubscribe('alice', FEED_ID)
    const n = t.net.calls.length
    t.clock.t += 30 * 3600000
    await t.svc.tick()
    assert.equal(t.net.calls.length, n)
    assert.deepEqual(await t.svc.refreshFeed(FEED_ID), { ok: false, error: 'not_found' })
  } finally { t.cleanup() }
})

test('unsubscribing the last follower removes the show, its episodes and downloaded files', async () => {
  const t = await setup({ [FEED_URL]: { body: rss(eps(2)) } })
  try {
    await t.svc.subscribe('alice', FEED_URL, { autoDownload: 2 })
    await t.svc.subscribe('bob', FEED_URL)
    await t.svc.whenIdle()
    assert.equal(fs.readdirSync(path.join(t.dir, 'downloads', FEED_ID)).length, 2)
    await t.svc.unsubscribe('alice', FEED_ID)
    assert.ok(fs.existsSync(path.join(t.dir, 'downloads', FEED_ID)), 'bob still follows it')
    await t.svc.unsubscribe('bob', FEED_ID)
    assert.ok(!fs.existsSync(path.join(t.dir, 'downloads', FEED_ID)))
    assert.ok(!fs.existsSync(path.join(t.dir, 'feeds', FEED_ID + '.json')))
    assert.deepEqual(Object.keys(t.svc._state.feeds), [])
    assert.deepEqual(Object.keys(t.svc._state.downloads), [])
    await assert.rejects(t.svc.unsubscribe('bob', FEED_ID), { code: 'not_found' })
  } finally { t.cleanup() }
})

test('auto-download: newest N per show, skips what everyone has played, files land in the capped folder', async () => {
  const t = await setup({ [FEED_URL]: { body: rss(eps(5)) } })
  try {
    await t.svc.subscribe('alice', FEED_URL, { autoDownload: 2 })
    await t.svc.whenIdle()
    const have = () => Object.keys(t.svc._state.downloads).sort()
    assert.deepEqual(have(), [keyOf(FEED_ID, 'g4'), keyOf(FEED_ID, 'g5')].sort(), 'the newest two')
    const dl = t.svc.episodes('alice', FEED_ID).episodes.filter((e) => e.downloaded).map((e) => e.title)
    assert.deepEqual(dl.sort(), ['Ep 4', 'Ep 5'])
    // a new episode arrives: the newest two are now g5, g6
    t.net.routes[FEED_URL] = { body: rss(eps(6)) }
    await t.svc.refreshFeed(FEED_ID)
    await t.svc.whenIdle()
    assert.ok(have().includes(keyOf(FEED_ID, 'g6')))
    // cleanup drops the one that fell out of "newest 2" (g4) and keeps the rest
    const r = await t.svc.cleanup()
    assert.equal(r.removed, 1)
    assert.deepEqual(have(), [keyOf(FEED_ID, 'g5'), keyOf(FEED_ID, 'g6')].sort())
    // played by the only person who wanted it: no longer needed, so it goes
    t.svc.markPlayed('alice', keyOf(FEED_ID, 'g6'), true)
    await t.svc.cleanup()
    assert.deepEqual(have(), [keyOf(FEED_ID, 'g5')])
    // the setting bounds what anyone can ask for
    assert.equal(t.svc.updateSubscription('alice', FEED_ID, { autoDownload: 500 }).autoDownload, 10)
    assert.equal(t.svc.updateSubscription('alice', FEED_ID, { autoDownload: -3 }).autoDownload, 0)
  } finally { t.cleanup() }
})

test('the download folder is capped: cleanup evicts unneeded first, then oldest, never queued or half-played', async () => {
  const MB = 1024 * 1024
  const routes = { [FEED_URL]: { body: rss(eps(6)) } }
  for (let i = 1; i <= 6; i++) routes[`https://cdn.example.test/g${i}.mp3`] = { size: MB, headers: { 'content-type': 'audio/mpeg' } }
  const t = await setup(routes, { settings: { downloadCapMb: 3 } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    // she pins four episodes by hand; the cap is 3 MB
    for (const g of ['g1', 'g2', 'g3']) { t.svc.requestDownload('alice', keyOf(FEED_ID, g)); await t.svc.whenIdle() }
    assert.equal(Object.keys(t.svc._state.downloads).length, 3)
    t.svc.queueAdd('alice', keyOf(FEED_ID, 'g1'))
    t.svc.setProgress('alice', keyOf(FEED_ID, 'g2'), 600, 3600)
    // a fourth needs room: the oldest that is neither queued nor in progress (g3) makes way
    t.svc.requestDownload('alice', keyOf(FEED_ID, 'g4'))
    await t.svc.whenIdle()
    const have = Object.keys(t.svc._state.downloads)
    assert.ok(have.includes(keyOf(FEED_ID, 'g4')))
    assert.ok(have.includes(keyOf(FEED_ID, 'g1')) && have.includes(keyOf(FEED_ID, 'g2')), 'queued and half-played survive')
    assert.ok(!have.includes(keyOf(FEED_ID, 'g3')))
    const st = t.svc.status()
    assert.ok(st.downloads.bytes <= st.downloads.capBytes)
    assert.equal(fs.readdirSync(path.join(t.dir, 'downloads', FEED_ID)).length, 3, 'files match the records')
    // downloads switched off entirely
    t.svc.setSettings({ downloadCapMb: 0 })
    assert.throws(() => t.svc.requestDownload('alice', keyOf(FEED_ID, 'g5')), { code: 'downloads_off' })
  } finally { t.cleanup() }
})

test('a download that is not media (an HTML paywall page) or fails is reported, not saved', async () => {
  const routes = { [FEED_URL]: { body: rss(eps(2)) } }
  routes['https://cdn.example.test/g1.mp3'] = { headers: { 'content-type': 'text/html' } }
  routes['https://cdn.example.test/g2.mp3'] = { status: 404 }
  const t = await setup(routes)
  try {
    await t.svc.subscribe('alice', FEED_URL)
    t.svc.requestDownload('alice', keyOf(FEED_ID, 'g1'))
    t.svc.requestDownload('alice', keyOf(FEED_ID, 'g2'))
    await t.svc.whenIdle()
    assert.deepEqual(Object.keys(t.svc._state.downloads), [])
    assert.equal(t.svc.downloadInfo(keyOf(FEED_ID, 'g1')).status, 'failed')
    assert.equal(t.svc.downloadInfo(keyOf(FEED_ID, 'g1')).downloaded, false)
    assert.equal(t.svc.downloadInfo(keyOf(FEED_ID, 'g2')).error, 'http_status')
    // the audio still resolves to the publisher's address for streaming
    assert.deepEqual(t.svc.resolveAudio(keyOf(FEED_ID, 'g1')).kind, 'remote')
    // a person deleting a download
    routes['https://cdn.example.test/g1.mp3'] = { headers: { 'content-type': 'audio/mpeg' } }
    t.svc.requestDownload('alice', keyOf(FEED_ID, 'g1'))
    await t.svc.whenIdle()
    assert.equal(t.svc.resolveAudio(keyOf(FEED_ID, 'g1')).kind, 'file')
    await t.svc.removeDownload('alice', keyOf(FEED_ID, 'g1'))
    assert.equal(t.svc.resolveAudio(keyOf(FEED_ID, 'g1')).kind, 'remote')
  } finally { t.cleanup() }
})

test('OPML: import stores shows without fetching them, the background pass fetches them; export lists only yours', async () => {
  const other = 'https://example.test/atom.xml'
  const t = await setup({ [FEED_URL]: { body: rss(eps(2), 'Imported One') }, [other]: { body: fx('feed-atom.xml') } })
  try {
    const r = await t.svc.importOpml('alice', fx('subscriptions.opml'))
    assert.deepEqual([r.added, r.existing, r.total], [2, 0, 2])
    assert.equal(t.net.calls.length, 0, 'an import of many shows does not fetch them all at once')
    const before = t.svc.subscriptions('alice')
    assert.equal(before.length, 2)
    assert.ok(before.every((s) => s.pending))
    assert.equal(before.find((s) => s.title === 'The Example Show').pending, true, 'titles come from the file until fetched')
    const tick = await t.svc.tick()
    assert.equal(tick.refreshed, 2)
    const after = t.svc.subscriptions('alice')
    assert.deepEqual(after.map((s) => s.title).sort(), ['Atom Cast', 'Imported One'])
    assert.ok(after.every((s) => !s.pending))
    assert.deepEqual(await t.svc.importOpml('alice', fx('subscriptions.opml')).then((x) => [x.added, x.existing]), [0, 2])
    const opml = t.svc.exportOpml('alice')
    assert.deepEqual(feedLib.parseOpml(Buffer.from(opml)).map((x) => x.xmlUrl).sort(), [other, FEED_URL].sort())
    assert.deepEqual(feedLib.parseOpml(Buffer.from(t.svc.exportOpml('nobody'))), [])
    await assert.rejects(t.svc.importOpml('alice', '<rss/>'), { code: 'not_opml' })
    await assert.rejects(t.svc.importOpml('alice', fx('feed-xxe.xml')), { code: 'not_opml' })
  } finally { t.cleanup() }
})

test('search (iTunes, discovery only): shaped, marked as followed, cached, rate limited, never given the LAN allowance', async () => {
  const hits = []
  const searchFetcher = { async get(url, o) { hits.push(url); assert.deepEqual(o.allowHosts, ['itunes.apple.com']); return { status: 200, headers: {}, body: fx('itunes-search.json') } } }
  const t = await setup({ [FEED_URL]: { body: rss(eps(1)) } }, { extra: { searchFetcher } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    const r = await t.svc.search('alice', 'example show')
    assert.deepEqual(r.map((x) => x.feedUrl), [FEED_URL, 'http://example.test/other.rss'])
    assert.equal(r[0].subscribed, true)
    assert.equal(r[1].subscribed, false)
    assert.ok(hits[0].startsWith('https://itunes.apple.com/search?'))
    assert.match(hits[0], /media=podcast/)
    assert.match(hits[0], /term=example\+show/)
    assert.match(hits[0], /country=US/)
    await t.svc.search('alice', 'Example Show')
    assert.equal(hits.length, 1, 'the same search inside ten minutes is answered from memory')
    await assert.rejects(t.svc.search('alice', 'a'), { code: 'query_too_short' })
    for (let i = 0; i < 14; i++) await t.svc.search('alice', 'query ' + i)
    await assert.rejects(t.svc.search('alice', 'one too many'), { code: 'rate_limited', status: 429 })
    t.clock.t += 61000
    assert.ok((await t.svc.search('alice', 'after a minute')).length)
    assert.match((await t.svc.search('alice', 'x y', { country: 'gb' }).then(() => hits[hits.length - 1])), /country=GB/)
  } finally { t.cleanup() }
})

test('chapters: Podcasting 2.0 JSON is fetched and cached; falls back to feed inline, then ID3 in the downloaded file', async () => {
  const chaptersUrl = 'https://example.test/g1.chapters.json'
  const routes = {
    [FEED_URL]: { body: rss([{ title: 'With JSON', guid: 'g1', at: T0, extra: `<podcast:chapters url="${chaptersUrl}" type="application/json+chapters"/>` }, { title: 'Plain', guid: 'g2', at: T0 + DAY }, { title: 'Broken chapters', guid: 'g3', at: T0 + 2 * DAY, extra: '<podcast:chapters url="https://example.test/broken.json"/>' }]) },
    [chaptersUrl]: { body: fx('chapters.json') },
    'https://example.test/broken.json': { status: 500, body: 'oops' }
  }
  // g2's downloaded file carries an ID3 chapter frame
  const synch = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const tit = Buffer.concat([Buffer.from('TIT2'), u32(1 + 8), Buffer.from([0, 0]), Buffer.from([3]), Buffer.from('From ID3')])
  const chap = Buffer.concat([Buffer.from('CHAP'), u32(3 + 16 + tit.length), Buffer.from([0, 0]), Buffer.from('c1\0'), u32(0), u32(9000), u32(0xffffffff), u32(0xffffffff), tit])
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synch(chap.length), chap, Buffer.from('audio')])
  routes['https://cdn.example.test/g2.mp3'] = { body: id3, headers: { 'content-type': 'audio/mpeg' } }
  const t = await setup(routes)
  try {
    await t.svc.subscribe('alice', FEED_URL)
    const j = await t.svc.chapters('alice', keyOf(FEED_ID, 'g1'))
    assert.equal(j.source, 'json')
    assert.deepEqual(j.chapters.map((c) => c.title), ['Intro', 'Hidden ad break', 'Second', 'Bad urls'])
    await t.svc.chapters('alice', keyOf(FEED_ID, 'g1'))
    assert.equal(t.net.calls.filter((c) => c.url === chaptersUrl).length, 1, 'cached after the first fetch')
    assert.deepEqual(await t.svc.chapters('alice', keyOf(FEED_ID, 'g2')), { source: 'none', chapters: [] })
    t.svc.requestDownload('alice', keyOf(FEED_ID, 'g2'))
    await t.svc.whenIdle()
    const i = await t.svc.chapters('alice', keyOf(FEED_ID, 'g2'))
    assert.equal(i.source, 'id3')
    assert.deepEqual(i.chapters.map((c) => [c.start, c.end, c.title]), [[0, 9, 'From ID3']])
    assert.equal((await t.svc.chapters('alice', keyOf(FEED_ID, 'g3'))).source, 'none', 'a chapters address that fails does not break the episode')
    await assert.rejects(t.svc.chapters('mallory', keyOf(FEED_ID, 'g1')), { code: 'not_subscribed' })
  } finally { t.cleanup() }
})

test('skip silence: only for downloaded episodes, builds a trimmed copy in the background, one at a time', async () => {
  const jobs = []
  const runFfmpeg = async (args) => {
    jobs.push(args)
    fs.writeFileSync(args[args.length - 1], Buffer.alloc(400, 3))
    return { ok: true }
  }
  const t = await setup({ [FEED_URL]: { body: rss(eps(2)) } }, { extra: { runFfmpeg } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    const k = keyOf(FEED_ID, 'g1')
    assert.throws(() => t.svc.requestSilenceSkip('alice', k), { code: 'download_first' })
    t.svc.requestDownload('alice', k)
    await t.svc.whenIdle()
    assert.equal(t.svc.resolveAudio(k, { variant: 'nosilence' }).kind, 'missing')
    const info = t.svc.requestSilenceSkip('alice', k)
    assert.equal(info.silence.ready, false)
    await t.svc.whenIdle()
    assert.equal(jobs.length, 1)
    assert.ok(jobs[0].join(' ').includes('silenceremove='), 'ffmpeg silenceremove filter')
    assert.ok(jobs[0].includes('-nostdin') && !jobs[0].includes('-shell'))
    const v = t.svc.resolveAudio(k, { variant: 'nosilence' })
    assert.equal(v.kind, 'file')
    assert.ok(v.path.endsWith('.ns.m4a') && fs.existsSync(v.path))
    assert.equal(t.svc.downloadInfo(k).silence.ready, true)
    // a second request does nothing new
    t.svc.requestSilenceSkip('alice', k)
    await t.svc.whenIdle()
    assert.equal(jobs.length, 1)
    // removing the download removes the trimmed copy too
    const p = v.path
    await t.svc.removeDownload('alice', k)
    assert.ok(!fs.existsSync(p))
    // args are a plain array with no shell metacharacter risk: the path is one argument
    const a = silenceArgs('C:\\a b\\in file.mp3', 'C:\\a b\\out.m4a.part')
    assert.equal(a[a.indexOf('-i') + 1], 'file:C:\\a b\\in file.mp3', 'the input is a file: path, never a protocol or option')
    assert.equal(a[a.indexOf('-protocol_whitelist') + 1], 'file,crypto,pipe')
  } finally { t.cleanup() }
})

test('skip silence with no ffmpeg is a clear "not available", and a failed ffmpeg run reports failure without leaving files', async () => {
  const t = await setup({ [FEED_URL]: { body: rss(eps(1)) } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    t.svc.requestDownload('alice', keyOf(FEED_ID, 'g1'))
    await t.svc.whenIdle()
    assert.throws(() => t.svc.requestSilenceSkip('alice', keyOf(FEED_ID, 'g1')), { code: 'no_ffmpeg', status: 501 })
  } finally { t.cleanup() }
  const bad = await setup({ [FEED_URL]: { body: rss(eps(1)) } }, { extra: { runFfmpeg: async () => ({ ok: false, error: 'Invalid data found' }) } })
  try {
    await bad.svc.subscribe('alice', FEED_URL)
    const k = keyOf(FEED_ID, 'g1')
    bad.svc.requestDownload('alice', k)
    await bad.svc.whenIdle()
    bad.svc.requestSilenceSkip('alice', k)
    await bad.svc.whenIdle()
    assert.equal(bad.svc.downloadInfo(k).silence.status, 'failed')
    assert.deepEqual(fs.readdirSync(path.join(bad.dir, 'downloads', FEED_ID)).filter((n) => n.includes('.ns')), [])
  } finally { bad.cleanup() }
})

test('state survives a restart; a damaged state file is set aside, not fatal', async () => {
  const t = await setup({ [FEED_URL]: { body: rss(eps(2)) } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    t.svc.setProgress('alice', keyOf(FEED_ID, 'g1'), 100, 3600)
    t.svc.setPrefs('alice', { speed: 1.8 })
    t.svc.saveNow()
    const again = t.mk()
    assert.equal(again.subscriptions('alice')[0].title, 'Show')
    assert.equal(again.episodes('alice', FEED_ID).episodes.find((e) => e.key === keyOf(FEED_ID, 'g1')).progressSec, 100)
    assert.equal(again.getPrefs('alice').speed, 1.8)
    fs.writeFileSync(path.join(t.dir, 'state.json'), '{"feeds": {"broken')
    const recovered = t.mk()
    assert.ok(Array.isArray(recovered.subscriptions('alice')), 'starts (from the backup or empty) instead of throwing')
    assert.ok(fs.readdirSync(t.dir).some((n) => n.startsWith('state.json.corrupt-')), 'the damaged file is kept aside')
  } finally { t.cleanup() }
})

test('account deletion removes that person and any show only they followed', async () => {
  const t = await setup({ [FEED_URL]: { body: rss(eps(2)) }, 'https://example.test/atom.xml': { body: fx('feed-atom.xml') } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    await t.svc.subscribe('bob', FEED_URL)
    await t.svc.subscribe('alice', 'https://example.test/atom.xml')
    await t.svc.removeUser('alice')
    assert.deepEqual(t.svc.subscriptions('alice'), [])
    assert.deepEqual(Object.keys(t.svc._state.feeds), [FEED_ID], 'bob still follows the first; the atom-only show is gone')
    assert.equal(t.svc.subscriptions('bob').length, 1)
    assert.ok(!('alice' in t.svc._state.users))
  } finally { t.cleanup() }
})

test('episode details carry sanitized notes; streams resolve to a local file once downloaded', async () => {
  const t = await setup({ [FEED_URL]: { body: fx('feed-basic.xml') } })
  try {
    await t.svc.subscribe('alice', FEED_URL)
    const list = t.svc.episodes('alice', FEED_ID).episodes
    const e3 = list.find((e) => e.title === 'Episode 3: Chapters')
    assert.equal(e3.hasChapters, true)
    const detail = t.svc.getEpisode('alice', e3.key)
    assert.doesNotMatch(detail.notesHtml, /<script|onclick|javascript:/i)
    assert.equal(detail.transcripts.length, 1)
    assert.match(detail.stream, /^\/api\/podcasts\/episode\/[a-f0-9]{12}\.[a-f0-9]{16}\/stream$/)
    assert.equal(t.svc.resolveAudio(e3.key).kind, 'remote')
    assert.equal(t.svc.resolveAudio(e3.key).url, 'https://cdn.example.test/ep3.mp3')
    assert.equal(t.svc.resolveAudio('nope'), null)
  } finally { t.cleanup() }
})
