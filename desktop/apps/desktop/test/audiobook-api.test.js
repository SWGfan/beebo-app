// The /api/audiobooks routes end to end through the real stream server: sign-in, ids that try to
// escape, Range audio and media tokens, per-person progress and bookmarks, "continue listening" and the
// reading-order view, admin-only actions, the optional Open Library lookup (stubbed network), the
// website page and its cookie-authenticated data routes, and account deletion.
// Run: node --test test/audiobook-api.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const server = localRequire('./electron/streamServer')
const auth = localRequire('./electron/auth')
const lib = localRequire('./electron/audiobookLibrary')
const transcode = localRequire('./electron/musicTranscode')
const userDeletion = localRequire('./electron/userDeletion')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')

async function write(file, data = 'x') {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
}

// A shelf of dummy files (the fake reader answers by file name) so nothing needs an audio decoder.
async function makeShelf(root) {
  const shelf = path.join(root, 'Audiobooks')
  const audio = Buffer.alloc(5000)
  for (let i = 0; i < audio.length; i++) audio[i] = i % 251
  const table = {}
  const T = (album, o = {}) => ({ album, artist: 'Ann Author', duration: 1000, codec: 'aac', container: 'M4A/isom', ...o })
  await write(path.join(shelf, 'Ann Author', 'Saga', '01 - First.m4b'), audio)
  table['01 - First.m4b'] = T('First', { duration: 1000, chapters: [{ title: 'Start', start: 0 }, { title: 'Middle', start: 400 }, { title: 'End', start: 800 }] })
  await write(path.join(shelf, 'Ann Author', 'Saga', '02 - Second.m4b'), audio)
  table['02 - Second.m4b'] = T('Second', { duration: 2000 })
  await write(path.join(shelf, 'Ann Author', 'Saga', '03 - Third.m4b'), audio)
  table['03 - Third.m4b'] = T('Third', { duration: 3000 })
  await write(path.join(shelf, 'Bob Writer', 'Standalone.m4b'), audio)
  table['Standalone.m4b'] = T('Standalone', { artist: 'Bob Writer', duration: 500 })
  await write(path.join(shelf, 'Bob Writer', 'Standalone.jpg'), JPG)
  // A three-file folder book.
  for (const n of ['1.mp3', '2.mp3', '3.mp3']) await write(path.join(shelf, 'Cy Speaker', 'Folder Tale', n), Buffer.from('mp3-' + n))
  table['1.mp3'] = { duration: 100, codec: 'MPEG 1 Layer 3', container: 'MPEG' }
  table['2.mp3'] = { duration: 200, codec: 'MPEG 1 Layer 3', container: 'MPEG' }
  table['3.mp3'] = { duration: 300, codec: 'MPEG 1 Layer 3', container: 'MPEG' }
  await write(path.join(shelf, 'Audible', 'Locked.aax'), 'drm')
  return { shelf, table, audio }
}

const fakeReader = (table) => async (file) => {
  const t = table[path.basename(file)]
  if (!t) throw new Error('unreadable')
  return t
}

async function boot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-ab-api-'))
  const { shelf, table, audio } = await makeShelf(root)
  const cache = path.join(root, 'cache')
  await fsp.mkdir(path.join(root, 'Movies'), { recursive: true })
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'Listener', 'listener@example.com')
  const { user: other } = auth.createUser(store, 'Other Person', 'other@example.com')
  const { user: admin } = auth.createUser(store, 'Owner', 'owner@example.com')
  auth.setUserAdmin(store, admin.id, true)
  const tokens = { user: server.makeApiToken(store, user.id), other: server.makeApiToken(store, other.id), admin: server.makeApiToken(store, admin.id) }
  const library = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => cache, readTags: fakeReader(table) })
  await library.scan()
  let lookupOn = false
  const fetchLog = []
  const stub = async (url) => {
    fetchLog.push(String(url))
    if (String(url).includes('search.json')) return new Response(JSON.stringify({ docs: [{ key: '/works/OL1W', title: 'Standalone', author_name: ['Bob Writer'], first_publish_year: 1999, subject: ['Fiction', 'Sea stories'], cover_i: 42 }] }), { status: 200 })
    return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  }
  const port = testPort()
  const info = server.startStreamServer({
    port, store, getMoviesDir: () => path.join(root, 'Movies'), getTvShowsDir: () => null,
    getAllMoviesDirs: () => [path.join(root, 'Movies')], getAllTvShowsDirs: () => [],
    getTmdbCacheDir: () => cache, log: () => {}, audiobooks: library,
    getAudiobooksLookupEnabled: () => lookupOn, audiobookFetch: stub
  })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  t.after(async () => {
    await new Promise((r) => info.close(r))
    // A rescan the test asked for may still be writing its index; let it finish before the folder goes.
    await library.scan().catch(() => {})
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const get = async (u, { bearer = tokens.user, headers = {}, method = 'GET', body } = {}) => {
    const res = await fetch(base + u, {
      method,
      redirect: 'manual',
      headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const buf = Buffer.from(await res.arrayBuffer())
    let json = null
    try { json = JSON.parse(buf.toString('utf8')) } catch {}
    return { status: res.status, headers: res.headers, buf, body: json }
  }
  return { root, shelf, audio, store, data, user, other, admin, tokens, library, info, base, get, setLookup: (v) => { lookupOn = v }, fetchLog }
}

const byTitle = (items, title) => items.find((b) => b.title === title)

test('sign-in is required, ids that are not ids find nothing, no folder names leak', async (t) => {
  const c = await boot(t)
  for (const u of ['/api/audiobooks/status', '/api/audiobooks/books', '/api/audiobooks/series', '/api/audiobooks/authors', '/api/audiobooks/continue', '/api/audiobooks/reading-order', '/api/audiobooks/progress', '/api/audiobooks/prefs', '/api/audiobooks/search?q=a']) {
    assert.equal((await c.get(u, { bearer: null })).status, 401, u)
  }
  assert.equal((await c.get('/api/audiobooks/books', { bearer: 'someone.123.forged' })).status, 401)

  let r = await c.get('/api/audiobooks/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.bookCount, 5)
  assert.equal(r.body.skippedCount, 1)
  assert.deepEqual(r.body.lookup, { enabled: false })

  r = await c.get('/api/audiobooks/books')
  assert.equal(r.body.total, 5)
  const first = byTitle(r.body.items, 'First')
  assert.equal(first.series, 'Saga')
  assert.equal(first.seriesIndex, 1)
  assert.equal(first.chapterCount, 3)
  assert.equal(first.status, 'unstarted')
  assert.equal(first.progress, null)
  assert.ok(!JSON.stringify(r.body).includes('Audiobooks'), 'no folder names')
  assert.ok(!('path' in first) && !('parts' in first))
  assert.equal(r.body.items.filter((b) => b.series === 'Saga').length, 3)

  for (const bad of ['..%2F..%2Fwindows%2Fwin.ini', '..%5C..%5Cwin.ini', 'ZZZZZZZZZZZZZZZZ', 'f'.repeat(16), '%00', first.id + '.m4b', first.id + '%2F..']) {
    assert.equal((await c.get(`/api/audiobooks/book/${bad}`)).status, 404, 'book ' + bad)
    assert.equal((await c.get(`/api/audiobooks/book/${bad}/stream`)).status, 404, 'stream ' + bad)
    assert.equal((await c.get(`/api/audiobooks/book/${bad}/progress`)).status, 404, 'progress ' + bad)
    assert.equal((await c.get(`/api/audiobooks/series/${bad}`)).status, 404, 'series ' + bad)
    assert.equal((await c.get(`/api/audiobooks/cover/${bad}`, { bearer: null })).status, 404, 'cover ' + bad)
  }
  assert.equal((await c.get('/api/audiobooks/nothing-here')).status, 404)
  assert.equal((await c.get('/api/audiobooks/status', { method: 'POST', body: {} })).status, 405)
})

test('book detail: chapters, parts, tokens, series, folder books, search', async (t) => {
  const c = await boot(t)
  const list = (await c.get('/api/audiobooks/books')).body.items
  const first = byTitle(list, 'First')
  let r = await c.get('/api/audiobooks/book/' + first.id)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.book.chapters.map((x) => [x.title, x.start, x.end]), [['Start', 0, 400], ['Middle', 400, 800], ['End', 800, 1000]])
  assert.equal(r.body.book.parts.length, 1)
  assert.equal(r.body.book.parts[0].stream, `/api/audiobooks/book/${first.id}/stream/0`, 'no token unless asked')
  assert.equal(r.body.nextInSeries.title, 'Second')
  assert.equal(r.body.speed, 1)
  assert.deepEqual(r.body.bookmarks, [])
  r = await c.get(`/api/audiobooks/book/${first.id}?tokens=1`)
  assert.match(r.body.book.parts[0].stream, /\?mt=/)

  const folder = byTitle(list, 'Folder Tale')
  r = await c.get('/api/audiobooks/book/' + folder.id)
  assert.equal(r.body.book.duration, 600)
  assert.deepEqual(r.body.book.parts.map((p) => [p.start, p.duration]), [[0, 100], [100, 200], [300, 300]])
  assert.deepEqual(r.body.book.chapters.map((x) => x.start), [0, 100, 300])
  assert.equal(r.body.book.chaptersSource, 'files')

  r = await c.get('/api/audiobooks/series')
  assert.equal(r.body.items.length, 1)
  const saga = r.body.items[0]
  assert.equal(saga.bookCount, 3)
  r = await c.get('/api/audiobooks/series/' + saga.id)
  assert.deepEqual(r.body.books.map((b) => b.title), ['First', 'Second', 'Third'])
  assert.equal(r.body.nextBookId, first.id)
  r = await c.get('/api/audiobooks/authors')
  assert.deepEqual(r.body.items.map((a) => a.name).sort(), ['Ann Author', 'Bob Writer', 'Cy Speaker'].sort())
  const ann = r.body.items.find((a) => a.name === 'Ann Author')
  r = await c.get('/api/audiobooks/author/' + ann.id)
  assert.equal(r.body.books.length, 3)
  assert.equal(r.body.series.length, 1)
  r = await c.get('/api/audiobooks/search?q=stand')
  assert.deepEqual(r.body.books.map((b) => b.title), ['Standalone'])
  r = await c.get('/api/audiobooks/books?q=saga')
  assert.equal(r.body.total, 3, 'series name search')
  r = await c.get('/api/audiobooks/books?authorId=' + ann.id + '&sort=duration&limit=2')
  assert.deepEqual(r.body.items.map((b) => b.title), ['Third', 'Second'])
  assert.equal(r.body.total, 3)
})

test('the audio: ranges, HEAD, media tokens for one book only, part numbers, covers', async (t) => {
  const c = await boot(t)
  const list = (await c.get('/api/audiobooks/books')).body.items
  const first = byTitle(list, 'First')
  const second = byTitle(list, 'Second')
  const folder = byTitle(list, 'Folder Tale')
  let r = await c.get(`/api/audiobooks/book/${first.id}/stream`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'audio/mp4')
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
  assert.ok(r.buf.equals(c.audio))
  r = await c.get(`/api/audiobooks/book/${first.id}/stream/0`, { headers: { Range: 'bytes=10-19' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${c.audio.length}`)
  assert.ok(r.buf.equals(c.audio.subarray(10, 20)))
  r = await c.get(`/api/audiobooks/book/${first.id}/stream`, { headers: { Range: 'bytes=-4' } })
  assert.ok(r.buf.equals(c.audio.subarray(c.audio.length - 4)))
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/stream`, { headers: { Range: `bytes=${c.audio.length}-` } })).status, 416)
  r = await c.get(`/api/audiobooks/book/${first.id}/stream`, { method: 'HEAD' })
  assert.equal(Number(r.headers.get('content-length')), c.audio.length)

  // Parts of a folder book.
  r = await c.get(`/api/audiobooks/book/${folder.id}/stream/2`)
  assert.equal(r.buf.toString(), 'mp3-3.mp3')
  assert.equal(r.headers.get('content-type'), 'audio/mpeg')
  for (const n of ['3', '99999', '-1', 'x', '1.5']) assert.equal((await c.get(`/api/audiobooks/book/${folder.id}/stream/${n}`)).status, 404, 'part ' + n)
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/stream/1`)).status, 404, 'a one-part book has no part 1')

  // Media tokens: signed for one book only, and only for the audio.
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/stream`, { bearer: null })).status, 401)
  const tokened = (await c.get(`/api/audiobooks/book/${first.id}?tokens=1`)).body.book.parts[0].stream
  assert.equal((await c.get(tokened, { bearer: null })).status, 200)
  const mt = decodeURIComponent(tokened.split('mt=')[1])
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/stream`, { bearer: null, headers: { 'X-Beebo-Media-Token': mt } })).status, 200, 'header form')
  assert.equal((await c.get(`/api/audiobooks/book/${second.id}/stream?mt=${encodeURIComponent(mt)}`, { bearer: null })).status, 401, 'token for another book')
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}?mt=${encodeURIComponent(mt)}`, { bearer: null })).status, 401, 'tokens only open the audio')
  for (const wrong of [c.tokens.user, server.makeMediaToken(c.store, first.id), server.makeMediaToken(c.store, 'music:' + first.id)]) {
    assert.equal((await c.get(`/api/audiobooks/book/${first.id}/stream?mt=${encodeURIComponent(wrong)}`, { bearer: null })).status, 401)
  }

  // Cover art: public by content hash.
  const withCover = byTitle(list, 'Standalone')
  assert.match(withCover.cover, /^\/api\/audiobooks\/cover\/[a-f0-9]{32}$/)
  r = await c.get(withCover.cover, { bearer: null })
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/jpeg')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.buf[0], 0xff)
})

test('progress: newest listen wins, batches, finishing, other people never see it, since=', async (t) => {
  const c = await boot(t)
  const list = (await c.get('/api/audiobooks/books')).body.items
  const first = byTitle(list, 'First')
  const put = (body, bearer = c.tokens.user, id = first.id) => c.get(`/api/audiobooks/book/${id}/progress`, { method: 'PUT', body, bearer })

  let r = await put({ position: 300, deviceId: 'phone-1', updatedAt: 1000 })
  assert.equal(r.status, 200)
  assert.equal(r.body.applied, true)
  assert.equal(r.body.progress.position, 300)
  assert.equal(r.body.progress.fraction, 0.3)
  assert.equal(r.body.progress.deviceId, 'phone-1')

  // A device that was offline sends an OLDER listen: ignored, and it is told what is stored.
  r = await put({ position: 50, deviceId: 'tablet', updatedAt: 500 })
  assert.equal(r.body.applied, false)
  assert.equal(r.body.progress.position, 300)
  r = await put({ position: 450, deviceId: 'car', updatedAt: 2000, speed: 1.25 })
  assert.equal(r.body.applied, true)
  assert.equal(r.body.progress.speed, 1.25)
  assert.equal(r.body.speed, 1.25)

  // Rules: numbers only, clamped to the book, no claiming a different duration.
  assert.equal((await put({ position: 'later' })).status, 400)
  assert.equal((await put({})).status, 400)
  r = await put({ position: 999999, updatedAt: 3000, duration: 5 })
  assert.equal(r.body.progress.position, 1000)
  assert.equal(r.body.progress.duration, 1000, 'the library says how long it is')
  assert.equal(r.body.progress.finished, true, 'the end counts as finished')
  r = await put({ position: -5, updatedAt: 4000 })
  assert.equal(r.body.progress.position, 0)
  assert.equal(r.body.progress.finished, false, 'going back un-finishes it')
  r = await put({ position: 500, updatedAt: Date.now() + 10 * 24 * 3600 * 1000 })
  assert.ok(r.body.progress.updatedAt <= Date.now() + 61000, 'a clock far in the future is clamped')

  // A different person sees nothing.
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/progress`, { bearer: c.tokens.other })).body.progress, null)
  assert.deepEqual((await c.get('/api/audiobooks/progress', { bearer: c.tokens.other })).body.items, [])
  assert.equal(byTitle((await c.get('/api/audiobooks/books', { bearer: c.tokens.other })).body.items, 'First').status, 'unstarted')
  assert.equal(byTitle((await c.get('/api/audiobooks/books')).body.items, 'First').status, 'in_progress')

  // Batch: several books at once, unknown ones reported.
  const second = byTitle(list, 'Second')
  r = await c.get('/api/audiobooks/progress/batch', { method: 'POST', body: { items: [{ bookId: second.id, position: 100, updatedAt: 10 }, { bookId: 'f'.repeat(16), position: 1 }, { bookId: first.id, position: 1, updatedAt: 1 }, { position: 1 }] } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.results.map((x) => x.applied), [true, false, false, false])
  assert.equal(r.body.results[1].error, 'not_found')
  assert.equal((await c.get('/api/audiobooks/progress/batch', { method: 'POST', body: { items: 'x' } })).status, 400)
  assert.equal((await c.get('/api/audiobooks/progress/batch')).status, 405)

  r = await c.get('/api/audiobooks/progress')
  assert.equal(r.body.items.length, 2)
  const cut = r.body.items.find((x) => x.bookId === first.id).updatedAt
  assert.deepEqual((await c.get('/api/audiobooks/progress?since=' + cut)).body.items.map((x) => x.bookId), [], 'nothing newer than the newest')
  assert.equal((await c.get('/api/audiobooks/progress?since=0')).body.items.length, 2)

  // Finish / start over / forget.
  r = await c.get(`/api/audiobooks/book/${first.id}/finished`, { method: 'POST', body: { finished: true } })
  assert.equal(r.body.progress.finished, true)
  assert.equal(r.body.progress.position, 1000)
  r = await c.get(`/api/audiobooks/book/${first.id}/finished`, { method: 'POST', body: { finished: false } })
  assert.equal(r.body.progress.finished, false)
  assert.equal(r.body.progress.position, 0)
  r = await c.get(`/api/audiobooks/book/${second.id}/progress`, { method: 'DELETE' })
  assert.equal(r.body.progress, null)
  assert.equal((await c.get(`/api/audiobooks/book/${second.id}/progress`)).body.progress, null)
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/progress`, { method: 'PATCH', body: {} })).status, 405)
})

test('continue listening and reading order', async (t) => {
  const c = await boot(t)
  const list = (await c.get('/api/audiobooks/books')).body.items
  const [first, second, third, standalone, folder] = ['First', 'Second', 'Third', 'Standalone', 'Folder Tale'].map((n) => byTitle(list, n))
  const put = (b, position, updatedAt, bearer = c.tokens.user) => c.get(`/api/audiobooks/book/${b.id}/progress`, { method: 'PUT', body: { position, updatedAt }, bearer })

  assert.deepEqual((await c.get('/api/audiobooks/continue')).body, { ok: true, items: [], nextUp: [] })

  await put(standalone, 100, 1000)
  await put(folder, 50, 3000)
  await put(first, 999, 2000) // finished
  let r = await c.get('/api/audiobooks/continue')
  assert.deepEqual(r.body.items.map((x) => x.book.title), ['Folder Tale', 'Standalone'], 'newest listen first, finished books left out')
  assert.equal(r.body.items[0].progress.position, 50)
  assert.deepEqual(r.body.nextUp.map((x) => [x.book.title, x.series.name]), [['Second', 'Saga']], 'the next book of a series being listened through')
  assert.deepEqual((await c.get('/api/audiobooks/continue?limit=1')).body.items.map((x) => x.book.title), ['Folder Tale'])

  await put(second, 10, 4000) // now Saga has one in progress: no "up next"
  r = await c.get('/api/audiobooks/continue')
  assert.deepEqual(r.body.nextUp, [])
  assert.equal(r.body.items[0].book.title, 'Second')
  assert.deepEqual((await c.get('/api/audiobooks/continue', { bearer: c.tokens.other })).body.items, [])

  r = await c.get('/api/audiobooks/reading-order')
  assert.equal(r.body.series.length, 1)
  const saga = r.body.series[0]
  assert.deepEqual(saga.books.map((b) => [b.title, b.status, b.next]), [['First', 'finished', false], ['Second', 'in_progress', true], ['Third', 'unstarted', false]])
  assert.equal(saga.finishedCount, 1)
  assert.equal(saga.nextBookId, second.id)
  assert.equal(r.body.standalone, undefined)
  r = await c.get('/api/audiobooks/reading-order?standalone=1')
  assert.deepEqual(r.body.standalone.map((b) => b.title).sort(), ['Folder Tale', 'Standalone'])
  assert.equal((await c.get('/api/audiobooks/reading-order?seriesId=' + saga.id)).body.series.length, 1)
  assert.equal((await c.get('/api/audiobooks/reading-order?seriesId=' + 'f'.repeat(16))).body.series.length, 0)
  r = await c.get('/api/audiobooks/reading-order', { bearer: c.tokens.other })
  assert.equal(r.body.series[0].nextBookId, first.id, 'someone else starts at book one')

  await put(second, 1999, 5000)
  await put(third, 5, 6000)
  await put(third, 2999, 7000)
  r = await c.get('/api/audiobooks/reading-order')
  assert.equal(r.body.series[0].finishedCount, 3)
  assert.equal(r.body.series[0].nextBookId, null, 'nothing left in the series')
  assert.deepEqual((await c.get('/api/audiobooks/continue')).body.nextUp, [])
  assert.equal((await c.get('/api/audiobooks/books?status=finished')).body.total, 3)
  assert.equal((await c.get('/api/audiobooks/books?status=in_progress')).body.total, 2)
  assert.equal((await c.get('/api/audiobooks/books?status=unstarted')).body.total, 0)
})

test('bookmarks and preferences are per person', async (t) => {
  const c = await boot(t)
  const first = byTitle((await c.get('/api/audiobooks/books')).body.items, 'First')
  const bm = `/api/audiobooks/book/${first.id}/bookmarks`
  let r = await c.get(bm, { method: 'POST', body: { at: 425.5, note: '  Great\nscene <b>  ' } })
  assert.equal(r.status, 201)
  assert.equal(r.body.bookmark.at, 425.5)
  assert.equal(r.body.bookmark.note, 'Great scene <b>')
  assert.match(r.body.bookmark.id, /^[a-f0-9]{12}$/)
  const id = r.body.bookmark.id
  await c.get(bm, { method: 'POST', body: { at: 5 } })
  assert.deepEqual((await c.get(bm)).body.items.map((b) => b.at), [5, 425.5], 'in book order')
  assert.equal((await c.get(bm, { method: 'POST', body: { at: -1 } })).status, 400)
  assert.equal((await c.get(bm, { method: 'POST', body: { at: 'x' } })).status, 400)
  assert.equal((await c.get(bm, { method: 'POST', body: { at: 99999 } })).body.bookmark.at, 1000, 'clamped to the book')
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}`)).body.bookmarks.length, 3)

  r = await c.get(`${bm}/${id}`, { method: 'PUT', body: { note: 'renamed' } })
  assert.equal(r.body.bookmark.note, 'renamed')
  assert.equal((await c.get(bm, { bearer: c.tokens.other })).body.items.length, 0, 'not shared')
  assert.equal((await c.get(`${bm}/${id}`, { method: 'DELETE', bearer: c.tokens.other })).status, 404, 'cannot delete someone else\'s')
  assert.equal((await c.get(`${bm}/${id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await c.get(`${bm}/${id}`, { method: 'DELETE' })).status, 404)
  assert.equal((await c.get(`${bm}/../x`, { method: 'DELETE' })).status, 404)
  assert.equal((await c.get(bm, { method: 'PUT', body: {} })).status, 405)

  // Bookmarking does not start the book.
  assert.equal(byTitle((await c.get('/api/audiobooks/books')).body.items, 'First').status, 'unstarted')
  assert.deepEqual((await c.get('/api/audiobooks/continue')).body.items, [])

  // Preferences: clamped, per person, kept between calls.
  r = await c.get('/api/audiobooks/prefs')
  assert.deepEqual(r.body.prefs, { speed: 1, skipBack: 15, skipForward: 30, sleepMinutes: 0, sleepEndOfChapter: false })
  r = await c.get('/api/audiobooks/prefs', { method: 'PUT', body: { speed: 9, skipBack: 1, skipForward: 500, sleepMinutes: 45.4, sleepEndOfChapter: 'yes', junk: 1 } })
  assert.deepEqual(r.body.prefs, { speed: 3, skipBack: 5, skipForward: 120, sleepMinutes: 45, sleepEndOfChapter: false })
  r = await c.get('/api/audiobooks/prefs', { method: 'PUT', body: { speed: 1.5 } })
  assert.equal(r.body.prefs.speed, 1.5)
  assert.equal(r.body.prefs.skipForward, 120, 'a partial update keeps the rest')
  assert.equal((await c.get('/api/audiobooks/prefs', { bearer: c.tokens.other })).body.prefs.speed, 1)
  const detail = (await c.get(`/api/audiobooks/book/${first.id}`)).body
  assert.equal(detail.speed, 1.5, 'a book with no speed of its own uses the default')
  assert.equal((await c.get('/api/audiobooks/prefs', { method: 'DELETE' })).status, 405)
})

test('owner-only actions, and the optional online lookup', async (t) => {
  const c = await boot(t)
  assert.equal((await c.get('/api/audiobooks/rescan', { method: 'POST' })).status, 403)
  assert.equal((await c.get('/api/audiobooks/rescan')).status, 405)
  assert.equal((await c.get('/api/audiobooks/rescan', { method: 'POST', bearer: c.tokens.admin })).status, 200)
  await c.library.scan()
  assert.equal((await c.get('/api/audiobooks/skipped')).status, 403)
  let r = await c.get('/api/audiobooks/skipped', { bearer: c.tokens.admin })
  assert.deepEqual(r.body.items, [{ name: 'Locked.aax', reason: 'drm' }])
  assert.match(r.body.reason, /copy-protected/)

  assert.equal((await c.get('/api/audiobooks/lookup')).status, 403)
  assert.equal((await c.get('/api/audiobooks/lookup', { method: 'POST', bearer: c.tokens.admin })).status, 409, 'off by default')
  assert.equal(c.fetchLog.length, 0, 'nothing left the computer')

  c.setLookup(true)
  r = await c.get('/api/audiobooks/lookup', { method: 'POST', bearer: c.tokens.admin, body: {} })
  assert.equal(r.status, 202)
  for (let i = 0; i < 100 && (await c.get('/api/audiobooks/lookup', { bearer: c.tokens.admin })).body.lookup.running; i++) await new Promise((res) => setTimeout(res, 50))
  r = await c.get('/api/audiobooks/lookup', { bearer: c.tokens.admin })
  assert.equal(r.body.lookup.running, false)
  assert.equal(r.body.lookup.found, 1, 'only "Standalone" is in the stub catalogue')
  assert.equal(r.body.lookup.total, 5)
  const queries = c.fetchLog.filter((u) => u.includes('search.json'))
  assert.equal(queries.length, 5)
  assert.ok(queries.every((u) => u.startsWith('https://openlibrary.org/search.json?')), 'only Open Library')
  assert.ok(!queries.some((u) => /Audiobooks|listener|owner|@/i.test(decodeURIComponent(u))), 'no folder names, users or e-mail addresses sent')
  const st = byTitle((await c.get('/api/audiobooks/books')).body.items, 'Standalone')
  assert.equal(st.year, 1999)
  assert.equal(st.genre, 'Sea stories')
  const detail = (await c.get('/api/audiobooks/book/' + st.id)).body.book
  assert.deepEqual(detail.onlineMatch, { source: 'openlibrary', key: '/works/OL1W' })
  assert.equal(c.fetchLog.filter((u) => u.includes('covers.openlibrary.org')).length, 0, 'it already had its own cover')
  // A second run does not ask again about books with an answer.
  const before = c.fetchLog.length
  await c.get('/api/audiobooks/lookup', { method: 'POST', bearer: c.tokens.admin, body: {} })
  for (let i = 0; i < 100 && (await c.get('/api/audiobooks/lookup', { bearer: c.tokens.admin })).body.lookup.running; i++) await new Promise((res) => setTimeout(res, 50))
  assert.equal(c.fetchLog.length, before, 'answered books are not asked again, and no-match books wait 30 days')
})

test('the website page and its cookie routes', async (t) => {
  const c = await boot(t)
  let r = await c.get('/audiobooks', { bearer: null })
  assert.equal(r.status, 302, 'sign in first')
  assert.equal((await c.get('/audiobooks-api/books', { bearer: null })).status, 302)
  const cookie = 'beebo_session=' + auth.signSession(c.store, c.user.id)
  r = await c.get('/audiobooks', { bearer: null, headers: { Cookie: cookie } })
  assert.equal(r.status, 200)
  const html = r.buf.toString('utf8')
  assert.match(html, /href="\/audiobooks"/, 'in the sidebar')
  assert.match(html, /Audiobooks/)
  assert.match(html, /5 books/)

  // The page's script must at least parse, and it inlines the shared player functions.
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1])
  const page = scripts.find((s) => s.includes('abx-audio'))
  assert.ok(page, 'the player script is on the page')
  assert.doesNotThrow(() => new vm.Script(page, { filename: 'audiobooks-page.js' }))
  for (const fn of ['clampSpeed', 'locate', 'chapterIndexAt', 'sleepStatus', 'skipTarget']) assert.match(page, new RegExp('function ' + fn + '\\('))

  r = await c.get('/audiobooks-api/books', { bearer: null, headers: { Cookie: cookie } })
  assert.equal(r.status, 200)
  assert.equal(r.body.total, 5)
  const first = byTitle(r.body.items, 'First')
  r = await c.get('/audiobooks-api/book/' + first.id + '?tokens=1', { bearer: null, headers: { Cookie: cookie } })
  assert.equal((await c.get(r.body.book.parts[0].stream, { bearer: null })).status, 200, 'the page plays with media tokens')
  r = await c.get(`/audiobooks-api/book/${first.id}/progress`, { bearer: null, method: 'PUT', headers: { Cookie: cookie }, body: { position: 123, updatedAt: 5 } })
  assert.equal(r.body.progress.position, 123)
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/progress`)).body.progress.position, 123, 'the same person, the same place, on the app')
  assert.equal((await c.get('/audiobooks-api/rescan', { bearer: null, method: 'POST', headers: { Cookie: cookie } })).status, 403, 'the website never rescans')

  // A cookie sent along by another site cannot change anything.
  const cross = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: c.info.port, path: `/audiobooks-api/book/${first.id}/progress`, method: 'PUT', headers: { Cookie: cookie, Origin: 'http://evil.example', 'Content-Type': 'application/json' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ position: 1, updatedAt: 99 }))
  })
  assert.equal(cross, 403)
  assert.equal((await c.get(`/api/audiobooks/book/${first.id}/progress`)).body.progress.position, 123)
  // Oversized and malformed bodies.
  r = await c.get(`/api/audiobooks/book/${first.id}/progress`, { method: 'PUT', body: { position: 1, pad: 'x'.repeat(70000) } })
  assert.equal(r.status, 413)
  const res = await fetch(c.base + `/api/audiobooks/book/${first.id}/progress`, { method: 'PUT', headers: { Authorization: 'Bearer ' + c.tokens.user, 'Content-Type': 'application/json' }, body: '{nope' })
  assert.equal(res.status, 400)
  await res.arrayBuffer()
})

test('the desktop bridge, and deleting an account deletes its places', async (t) => {
  const c = await boot(t)
  const first = byTitle((await c.get('/api/audiobooks/books')).body.items, 'First')
  await c.get(`/api/audiobooks/book/${first.id}/progress`, { method: 'PUT', body: { position: 77, updatedAt: 1 } })
  await c.get(`/api/audiobooks/book/${first.id}/bookmarks`, { method: 'POST', body: { at: 3 } })
  await c.get('/api/audiobooks/prefs', { method: 'PUT', body: { speed: 2 } })
  await c.get(`/api/audiobooks/book/${first.id}/progress`, { method: 'PUT', body: { position: 5, updatedAt: 1 }, bearer: c.tokens.other })

  // What main.js 'audiobooks:call' does for the owner.
  const owner = { id: c.admin.id, isAdmin: true }
  let out = c.info.audiobooks('GET', 'books', { q: 'first', tokens: '1' }, {}, owner)
  assert.equal(out.status, 200)
  assert.equal(out.body.items[0].title, 'First')
  out = c.info.audiobooks('PUT', '/book/' + first.id + '/progress', {}, { position: 10, updatedAt: 1 }, owner)
  assert.equal(out.body.progress.position, 10)
  assert.equal(c.info.audiobooks('POST', 'rescan', {}, {}, owner).status, 200)
  assert.equal(c.info.audiobooks('POST', 'rescan', {}, {}, { id: c.user.id, isAdmin: false }).status, 403)
  assert.equal(c.info.audiobooks('GET', 'nope', {}, {}, owner).status, 404)
  assert.equal(c.info.audiobooks('GET', 'books', {}, {}, null).status, 401)

  assert.ok(c.data.audiobookProgress[c.user.id])
  assert.ok(c.data.audiobookProgress[c.other.id])
  userDeletion.purgeUserData(c.store, c.user.id)
  assert.equal(c.data.audiobookProgress[c.user.id], undefined, 'their places, bookmarks and preferences are gone')
  assert.ok(c.data.audiobookProgress[c.other.id], 'other people keep theirs')
})

// --- conversion needs a real ffmpeg -------------------------------------------------------------

function findFf(name) {
  const bundled = transcode.resolveFf(name)
  if (bundled) return bundled
  const probe = spawnSync(name, ['-version'], { windowsHide: true })
  return probe.status === 0 ? name : null
}
const FFMPEG = findFf('ffmpeg')

test('a player without FLAC gets AAC for a flac audiobook', { skip: !FFMPEG && 'ffmpeg not found' }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-ab-conv-'))
  const savedFf = process.env.BEEBO_FFMPEG
  let info
  t.after(async () => {
    if (savedFf === undefined) delete process.env.BEEBO_FFMPEG
    else process.env.BEEBO_FFMPEG = savedFf
    if (info) await new Promise((r) => info.close(r))
    await fsp.rm(root, { recursive: true, force: true })
  })
  const shelf = path.join(root, 'Audiobooks', 'Flac Author', 'Flac Book')
  await fsp.mkdir(shelf, { recursive: true })
  const made = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'flac', '-metadata', 'album=Flac Book', path.join(shelf, 'one.flac')], { windowsHide: true })
  assert.equal(made.status, 0)
  await fsp.copyFile(path.join(shelf, 'one.flac'), path.join(shelf, 'two.flac'))
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v }, delete: (k) => { delete data[k] }, onDidChange: () => () => {} }
  const { user } = auth.createUser(store, 'L', 'l@example.com')
  const token = server.makeApiToken(store, user.id)
  process.env.BEEBO_FFMPEG = FFMPEG === 'ffmpeg' ? spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim() : FFMPEG
  const ffprobe = findFf('ffprobe')
  const library = lib.createAudiobookLibrary({ getDirs: () => [path.join(root, 'Audiobooks')], getCacheDir: () => path.join(root, 'cache'), ffprobePath: ffprobe, ffmpegPath: FFMPEG })
  await library.scan()
  const port = testPort()
  info = server.startStreamServer({ port, store, getMoviesDir: () => null, getTvShowsDir: () => null, getAllMoviesDirs: () => [], getAllTvShowsDirs: () => [], getTmdbCacheDir: () => path.join(root, 'cache'), log: () => {}, audiobooks: library })
  const base = 'http://127.0.0.1:' + info.port
  for (let i = 0; i < 50; i++) { try { await (await fetch(base + '/api/ping')).arrayBuffer(); break } catch { await new Promise((r) => setTimeout(r, 100)) } }
  const book = library.books()[0]
  assert.equal(book.partCount, 2)
  const orig = await fetch(`${base}/api/audiobooks/book/${book.id}/stream/1`, { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(orig.headers.get('content-type'), 'audio/flac')
  assert.equal(orig.headers.get('x-beebo-audiobook-transcode'), 'original')
  await orig.arrayBuffer()
  const conv = await fetch(`${base}/api/audiobooks/book/${book.id}/stream/1?codecs=mp3,aac`, { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(conv.status, 200)
  assert.equal(conv.headers.get('x-beebo-audiobook-transcode'), 'aac-256')
  assert.equal(conv.headers.get('content-type'), 'audio/mp4')
  const buf = Buffer.from(await conv.arrayBuffer())
  assert.equal(buf.subarray(4, 8).toString('ascii'), 'ftyp')
  const low = await fetch(`${base}/api/audiobooks/book/${book.id}/stream/0?quality=low`, { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(low.headers.get('x-beebo-audiobook-transcode'), 'aac-96')
  await low.arrayBuffer()
})
