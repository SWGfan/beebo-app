// Each person's place in each audiobook, bookmarks and preferences (electron/audiobookProgress.js)
// and the optional Open Library lookup (electron/audiobookMetadata.js) with the network stubbed.
// Run: node --test test/audiobook-progress.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const prog = localRequire('./electron/audiobookProgress')
const meta = localRequire('./electron/audiobookMetadata')
const lib = localRequire('./electron/audiobookLibrary')

const memoryStore = () => {
  const data = {}
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}
const BOOK = { id: 'a'.repeat(16), duration: 1000 }
const BOOK2 = { id: 'b'.repeat(16), duration: 3600 }

test('isFinished: the last few seconds count, more slack for a long book, none for unknown length', () => {
  assert.equal(prog.isFinished(1000, 1000), true)
  assert.equal(prog.isFinished(990, 1000), true, '10 s left of a 1000 s book: 2% is 20 s of slack')
  assert.equal(prog.isFinished(979, 1000), false)
  assert.equal(prog.isFinished(981, 1000), true)
  assert.equal(prog.isFinished(36000 - 45, 36000), true, 'never more than 45 s of slack')
  assert.equal(prog.isFinished(36000 - 46, 36000), false)
  assert.equal(prog.isFinished(60, 60), true)
  assert.equal(prog.isFinished(50, 60), false, 'at least 5 s is always allowed')
  assert.equal(prog.isFinished(56, 60), true)
  assert.equal(prog.isFinished(5, 0), false)
})

test('save / get: clamps, keeps the first start, remembers speed and device, newest listen wins', () => {
  const store = memoryStore()
  let clock = 10_000
  const p = prog.createProgress({ store, now: () => clock })
  assert.equal(p.get('u1', BOOK.id), null)
  let r = p.save('u1', BOOK, { position: 100.12345, deviceId: 'my phone!/../x', updatedAt: 5000 })
  assert.equal(r.applied, true)
  assert.equal(r.progress.position, 100.123)
  assert.equal(r.progress.deviceId, 'myphone..x', 'device names are reduced to safe characters')
  assert.equal(r.progress.startedAt, 5000)
  assert.equal(r.progress.speed, null)

  clock = 20_000
  r = p.save('u1', BOOK, { position: 200, speed: 1.5, updatedAt: 6000 })
  assert.equal(r.progress.startedAt, 5000)
  assert.equal(r.progress.speed, 1.5)
  assert.equal(r.progress.deviceId, 'myphone..x', 'kept when the newer save names no device')
  r = p.save('u1', BOOK, { position: 210, updatedAt: 7000 })
  assert.equal(r.progress.speed, 1.5, 'speed is kept when a save does not mention it')

  r = p.save('u1', BOOK, { position: 5, updatedAt: 100 })
  assert.equal(r.applied, false, 'older than what is stored')
  assert.equal(r.progress.position, 210)
  r = p.save('u1', BOOK, { position: 220, updatedAt: 7000 })
  assert.equal(r.applied, true, 'equal times: the later write wins')

  assert.equal(p.save('u1', BOOK, { position: 'x' }).error, 'bad_position')
  assert.equal(p.save('u1', { id: 'nope', duration: 1 }, { position: 1 }).error, 'bad_request')
  assert.equal(p.save('', BOOK, { position: 1 }).error, 'bad_request')
  assert.equal(p.save('u1', BOOK, { position: -50, updatedAt: 8000 }).progress.position, 0)
  assert.equal(p.save('u1', BOOK, { position: 5000, updatedAt: 9000 }).progress.position, 1000)
  assert.equal(p.save('u1', BOOK, { position: 10, updatedAt: 99_999_999_999_999 }).progress.updatedAt, clock + 60_000, 'a clock in the far future is pulled back')
  assert.equal(p.save('u1', BOOK, { position: 10, speed: 99, updatedAt: 80_000 }).progress.speed, 3)

  assert.equal(p.get('u2', BOOK.id), null, 'per person')
  assert.equal(p.get('u1', '../etc'), null)
  assert.deepEqual(Object.keys(store.data.audiobookProgress), ['u1'])
})

test('finishing: reaching the end finishes, scrubbing back un-finishes, mark finished / not started', () => {
  const store = memoryStore()
  let clock = 1000
  const p = prog.createProgress({ store, now: () => clock })
  let r = p.save('u', BOOK, { position: 1000, updatedAt: 1000 })
  assert.equal(r.progress.finished, true)
  assert.equal(r.progress.finishedAt, 1000)
  clock = 2000
  r = p.save('u', BOOK, { position: 1000, updatedAt: 2000 })
  assert.equal(r.progress.finishedAt, 1000, 'the first time it was finished is kept')
  r = p.save('u', BOOK, { position: 300, updatedAt: 3000 })
  assert.equal(r.progress.finished, false)
  assert.equal(r.progress.finishedAt, null)
  assert.equal(p.markFinished('u', BOOK, true).position, 1000)
  assert.equal(p.get('u', BOOK.id).finished, true)
  assert.equal(p.markFinished('u', BOOK, false).position, 0)
  assert.equal(p.get('u', BOOK.id).finished, false)
  assert.equal(p.markFinished('u', { id: 'bad' }, true), null)
})

test('list is newest first; remove forgets a book and its bookmarks; empty users leave no residue', () => {
  const store = memoryStore()
  const p = prog.createProgress({ store, now: () => 50_000 })
  p.save('u', BOOK, { position: 10, updatedAt: 1000 })
  p.save('u', BOOK2, { position: 20, updatedAt: 2000 })
  assert.deepEqual(p.list('u').map((x) => x.bookId), [BOOK2.id, BOOK.id])
  assert.deepEqual(p.list('nobody'), [])
  assert.equal(p.remove('u', BOOK.id), true)
  assert.equal(p.remove('u', BOOK.id), false)
  assert.equal(p.remove('u', 'zz'), false)
  assert.deepEqual(p.list('u').map((x) => x.bookId), [BOOK2.id])
  p.remove('u', BOOK2.id)
  assert.equal(store.data.audiobookProgress.u, undefined, 'nothing kept for a person with no data')
})

test('bookmarks: added in any order, listed in book order, capped, edited and removed by their owner', () => {
  const store = memoryStore()
  const p = prog.createProgress({ store, now: () => 5000 })
  const a = p.addBookmark('u', BOOK, { at: 500, note: '  a\tnote\n' })
  assert.equal(a.bookmark.note, 'a note')
  assert.match(a.bookmark.id, /^[a-f0-9]{12}$/)
  p.addBookmark('u', BOOK, { at: 10 })
  p.addBookmark('u', BOOK, { at: 5000 })
  assert.deepEqual(p.bookmarks('u', BOOK.id).map((b) => b.at), [10, 500, 1000], 'clamped to the book')
  assert.equal(p.get('u', BOOK.id).position, 0, 'a bookmark is not listening')
  assert.equal(p.get('u', BOOK.id).bookmarkCount, 3)
  assert.equal(p.addBookmark('u', BOOK, { at: -1 }).error, 'bad_position')
  assert.equal(p.addBookmark('u', BOOK, { at: 'x' }).error, 'bad_position')
  assert.equal(p.addBookmark('u', { id: '../..' }, { at: 1 }).error, 'bad_request')

  // Saving progress keeps the bookmarks.
  p.save('u', BOOK, { position: 20, updatedAt: 100 })
  assert.equal(p.bookmarks('u', BOOK.id).length, 3)
  assert.equal(p.updateBookmark('u', BOOK.id, a.bookmark.id, { note: 'renamed' }).note, 'renamed')
  assert.equal(p.updateBookmark('other', BOOK.id, a.bookmark.id, { note: 'x' }), null)
  assert.equal(p.removeBookmark('other', BOOK.id, a.bookmark.id), false)
  assert.equal(p.removeBookmark('u', BOOK.id, a.bookmark.id), true)
  assert.equal(p.removeBookmark('u', BOOK.id, a.bookmark.id), false)

  for (let i = 0; i < prog.MAX_BOOKMARKS_PER_BOOK; i++) p.addBookmark('u', BOOK, { at: i })
  assert.equal(p.addBookmark('u', BOOK, { at: 1 }).error, 'too_many_bookmarks')
})

test('preferences: defaults, clamps, partial updates, per person', () => {
  const store = memoryStore()
  const p = prog.createProgress({ store })
  assert.deepEqual(p.prefs('u'), prog.DEFAULT_PREFS)
  assert.deepEqual(p.setPrefs('u', { speed: 0.1, skipBack: 0, skipForward: 1000, sleepMinutes: -3, sleepEndOfChapter: true }), { speed: 0.5, skipBack: 5, skipForward: 120, sleepMinutes: 0, sleepEndOfChapter: true })
  assert.equal(p.setPrefs('u', { speed: 1.8 }).skipForward, 120)
  assert.deepEqual(p.setPrefs('u', null), p.prefs('u'))
  assert.deepEqual(p.prefs('v'), prog.DEFAULT_PREFS)
  assert.deepEqual(p.prefs(''), prog.DEFAULT_PREFS)
})

test('a damaged store is treated as empty, and removeUserData only touches that person', () => {
  const store = memoryStore()
  store.data.audiobookProgress = 'garbage'
  const p = prog.createProgress({ store })
  assert.deepEqual(p.list('u'), [])
  assert.equal(p.save('u', BOOK, { position: 1, updatedAt: 1 }).applied, true)
  p.save('v', BOOK, { position: 2, updatedAt: 1 })
  store.data.audiobookProgress.u.books.junk = 5
  assert.deepEqual(p.list('u').map((x) => x.bookId), [BOOK.id], 'non-books are ignored')
  assert.equal(prog.removeUserData(store, 'u'), true)
  assert.equal(prog.removeUserData(store, 'u'), false)
  assert.ok(store.data.audiobookProgress.v)
  assert.equal(prog.removeUserData(store, ''), false)
  assert.throws(() => prog.createProgress({}))
})

test('the most books per person is bounded, forgetting finished ones first', () => {
  const store = memoryStore()
  const p = prog.createProgress({ store, now: () => 1e12 })
  const many = {}
  for (let i = 0; i < 5000; i++) many[i.toString(16).padStart(16, '0')] = { position: 1, duration: 10, updatedAt: 1000 + i, finishedAt: i === 0 ? 1 : null, bookmarks: [] }
  store.data.audiobookProgress = { u: { books: many, prefs: null } }
  p.save('u', { id: 'f'.repeat(16), duration: 10 }, { position: 1, updatedAt: 1e11 })
  const ids = Object.keys(store.data.audiobookProgress.u.books)
  assert.equal(ids.length, 5000)
  assert.ok(!ids.includes('0'.repeat(16)), 'the finished book went first')
  assert.ok(ids.includes('f'.repeat(16)))
})

// ---------------------------------------------------------------------------
// Open Library
// ---------------------------------------------------------------------------

test('pickMatch: same title and a shared author name word, nothing fuzzier', () => {
  const docs = [
    { key: '/works/OL1W', title: 'The Hobbit', author_name: ['J. R. R. Tolkien'], first_publish_year: 1937 },
    { key: '/works/OL2W', title: 'The Hobbit Companion', author_name: ['Someone Else'] },
    { key: '/works/OL3W', title: 'The Hobbit', author_name: ['Random Person'], cover_i: 5 },
    { key: 'bad-key', title: 'The Hobbit', author_name: ['Tolkien'] }
  ]
  assert.equal(meta.pickMatch(docs, { title: 'The Hobbit', author: 'J.R.R. Tolkien' }).key, '/works/OL1W')
  assert.equal(meta.pickMatch(docs, { title: 'The Hobbit', author: 'Nobody Known' }), null, 'a different author is no match')
  assert.equal(meta.pickMatch(docs, { title: 'the hobbit', author: 'Unknown Author' }).key, '/works/OL3W', 'with no author to check, the better-scored same-title result wins')
  assert.equal(meta.pickMatch(docs, { title: 'The Hobbit: Or There and Back Again', author: 'Tolkien' }).key, '/works/OL1W', 'a subtitle on our side still matches the plain title')
  assert.equal(meta.pickMatch(docs, { title: 'Dune', author: '' }), null)
  assert.equal(meta.pickMatch([], { title: 'x' }), null)
  assert.equal(meta.pickMatch(null, { title: 'x' }), null)
  assert.equal(meta.pickMatch(docs, { title: '', author: '' }), null)
  assert.equal(meta.pickSubject(['Fiction', 'Audiobook', 'x'.repeat(80), 'Fantasy']), 'Fantasy')
  assert.equal(meta.pickSubject(['Fiction']), null)
  assert.equal(meta.pickSubject(null), null)
})

async function tinyLibrary(root, now) {
  const shelf = path.join(root, 'Audiobooks')
  const table = {}
  for (const [author, title] of [['Bob Writer', 'Standalone'], ['Zed Nobody', 'Unknown Thing']]) {
    await fsp.mkdir(path.join(shelf, author), { recursive: true })
    await fsp.writeFile(path.join(shelf, author, title + '.m4b'), 'x')
    table[title + '.m4b'] = { album: title, artist: author, duration: 60, codec: 'aac', container: 'M4A/isom' }
  }
  const library = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => path.join(root, 'cache'), readTags: async (f) => table[path.basename(f)], ...(now ? { now } : {}) })
  await library.scan()
  return library
}

test('the online lookup: off means silent, answers fill only what is missing, misses wait 30 days, failures stop the run', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-ab-ol-'))
  try {
    let on = false
    let clock = 1_000_000
    const library = await tinyLibrary(root, () => clock)
    const seen = []
    let mode = 'ok'
    const fetchImpl = async (url, opts) => {
      seen.push({ url: String(url), headers: opts && opts.headers })
      if (mode === 'down') throw new Error('offline')
      if (String(url).includes('covers.openlibrary.org')) return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200 })
      const u = new URL(String(url))
      if (u.searchParams.get('title') === 'Standalone') return new Response(JSON.stringify({ docs: [{ key: '/works/OL9W', title: 'Standalone', author_name: ['Bob Writer'], first_publish_year: 1980, subject: ['Fiction', 'Lighthouses'], cover_i: 7 }] }), { status: 200 })
      return new Response(JSON.stringify({ docs: [] }), { status: 200 })
    }
    const m = meta.createAudiobookMetadata({ library, getEnabled: () => on, fetchImpl, now: () => clock, minIntervalMs: 0 })
    const standalone = library.books().find((b) => b.title === 'Standalone')
    const unknown = library.books().find((b) => b.title === 'Unknown Thing')

    assert.equal(await m.enrichBook(standalone.id), 'skipped')
    assert.deepEqual(await m.enrichAll(), { running: false, done: 0, total: 0, found: 0, startedAt: 0, finishedAt: 0, error: null })
    m.kick()
    assert.equal(seen.length, 0, 'setting off: nothing is sent, ever')
    assert.equal(m.status().enabled, false)

    on = true
    const state = await m.enrichAll()
    assert.equal(state.total, 2)
    assert.equal(state.found, 1)
    assert.equal(state.error, null)
    const s = library.book(standalone.id)
    assert.equal(s.year, 1980)
    assert.equal(s.genre, 'Lighthouses')
    assert.match(s.coverId, /^[a-f0-9]{32}$/, 'a cover for a book with none')
    assert.ok(library.coverFile(s.coverId))
    assert.equal(library.book(unknown.id).year, null)
    assert.equal(library.enrichmentOf(unknown.id).miss, true)

    for (const call of seen) {
      assert.match(call.url, /^https:\/\/(openlibrary|covers\.openlibrary)\.org\//)
      assert.match(call.headers['User-Agent'], /^BeeboEntertainment\/[\d.]+ \(\S+@\S+\)$/, 'a descriptive User-Agent with a contact address')
    }
    const searches = seen.filter((c) => c.url.includes('search.json'))
    assert.equal(searches.length, 2)
    assert.ok(searches.every((c) => Object.keys(Object.fromEntries(new URL(c.url).searchParams)).every((k) => ['title', 'author', 'limit', 'fields'].includes(k))), 'only the title and author are sent')

    // Nothing is asked twice.
    seen.length = 0
    await m.enrichAll()
    assert.equal(seen.length, 0)
    clock += meta.MISS_RETRY_MS + 1
    await m.enrichAll()
    assert.equal(seen.filter((c) => c.url.includes('search.json')).length, 1, 'only the no-match book is retried after 30 days')

    // A network failure stops the run instead of trying every book.
    mode = 'down'
    seen.length = 0
    library.applyEnrichment(unknown.id, { miss: true, key: null })
    clock += meta.MISS_RETRY_MS + 1
    const failed = await m.enrichAll({ force: true })
    assert.equal(failed.error, 'lookup_failed')
    assert.equal(seen.length, 1, 'it gave up after the first failure')
    assert.equal(failed.running, false)
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('the online lookup refuses to run without a network function, and enrichBook reports errors quietly', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-ab-ol2-'))
  try {
    const library = await tinyLibrary(root)
    const logs = []
    const m = meta.createAudiobookMetadata({ library, getEnabled: () => true, fetchImpl: null, log: (s) => logs.push(s) })
    const b = library.books()[0]
    assert.equal(await m.enrichBook(b.id), 'error')
    assert.ok(logs.every((l) => !l.includes(b.title)), 'titles are not written to the log')
    const big = meta.createAudiobookMetadata({
      library, getEnabled: () => true, minIntervalMs: 0, log: (s) => logs.push(s),
      fetchImpl: async () => new Response(Buffer.alloc(2 * 1024 * 1024, 32), { status: 200 })
    })
    assert.equal(await big.enrichBook(b.id), 'error', 'an oversized answer is dropped')
    const http500 = meta.createAudiobookMetadata({ library, getEnabled: () => true, minIntervalMs: 0, log: (s) => logs.push(s), fetchImpl: async () => new Response('no', { status: 503 }) })
    assert.equal(await http500.enrichBook(b.id), 'error')
    assert.ok(logs.some((l) => l.includes('503')))
  } finally {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
