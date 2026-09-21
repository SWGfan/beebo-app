// Beebo Inbox (electron/inbox.js): drop videos in a folder, Beebo files them.
// Every test works in its own temp folder with a fake electron-store and a fake
// TMDB. Nothing here touches a real library.
// Run: node --test test/inbox.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { testPort } = require('./helpers/testPort')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const inboxMod = localRequire('./electron/inbox')
const titleMatch = localRequire('./electron/titleMatch')

function fakeStore(init) {
  const m = new Map(Object.entries(init || {}))
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), delete: (k) => m.delete(k) }
}
const movie = (id, title, year) => ({ id, title, original_title: title, release_date: `${year}-05-01`, popularity: 30, vote_count: 900, poster_path: `/m${id}.jpg` })
const show = (id, name, year) => ({ id, name, original_name: name, first_air_date: `${year}-01-01`, popularity: 40, vote_count: 900, poster_path: `/t${id}.jpg` })
function fakeApi() {
  const calls = []
  return {
    calls,
    get: async (p, params = {}) => {
      calls.push(p)
      const q = String(params.query || '').toLowerCase()
      if (p === '/search/tv') {
        if (q === 'house') return { ok: true, data: { results: [show(1408, 'House', 2004)] } }
        if (q === 'the office us') return { ok: true, data: { results: [show(2316, 'The Office', 2005)] } }
        return { ok: true, data: { results: [] } }
      }
      if (p === '/search/movie') {
        if (q === 'inception') return { ok: true, data: { results: [movie(27205, 'Inception', 2010)] } }
        if (q === 'arrival') return { ok: true, data: { results: [movie(329865, 'Arrival', 2016)] } }
        if (q === 'mystery clip') return { ok: true, data: { results: [movie(1, 'Mystery Men', 1999), movie(2, 'The Mystery Clip Show', 2003)] } }
        return { ok: true, data: { results: [] } }
      }
      if (p === '/tv/1408/season/2') return { ok: true, data: { episodes: [{ episode_number: 11, name: 'Need to Know' }] } }
      return { ok: false, status: 404 }
    }
  }
}

async function setup(t, opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-inbox-test-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const dirs = { root, inbox: path.join(root, 'Beebo Inbox'), movies: path.join(root, 'Movies'), tv: path.join(root, 'TVShows') }
  for (const d of [dirs.inbox, dirs.movies, dirs.tv]) await fsp.mkdir(d, { recursive: true })
  const store = opts.store || fakeStore()
  const api = opts.api === undefined ? fakeApi() : opts.api
  const sorted = []
  const notes = []
  const inbox = inboxMod.createInbox(Object.assign({
    store,
    getInboxDir: () => dirs.inbox,
    getMoviesDir: () => dirs.movies,
    getTvShowsDir: () => dirs.tv,
    getTmdbApi: () => api,
    undoLogPath: path.join(root, 'undo.jsonl'),
    stableMs: 0,
    freeSpace: async () => 1e15,
    onSorted: (info) => { sorted.push(info) },
    notify: (n) => notes.push(n)
  }, opts.inbox || {}))
  t.after(() => inbox.stop())
  return { dirs, store, api, inbox, sorted, notes }
}

async function put(file, content = 'video-bytes') {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content)
  return file
}
const has = (p) => fs.existsSync(p)
function listAll(dir) {
  const out = []
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}
const videosUnder = (root) => listAll(root).filter((f) => ['.mkv', '.mp4', '.avi'].includes(path.extname(f).toLowerCase()))

test('routing: an episode, a film and an unsure file each go to the right place', async (t) => {
  const { dirs, inbox, store, notes, sorted } = await setup(t)
  await put(path.join(dirs.inbox, 'house.s02e11.720p.hdtv.x264-lol.mkv'))
  await put(path.join(dirs.inbox, 'Inception.2010.1080p.BluRay.x264.mkv'))
  await put(path.join(dirs.inbox, 'Mystery Clip.mp4'))
  await inbox.scanOnce()

  assert.ok(has(path.join(dirs.tv, 'House', 'Season 02', 'House - S02E11 - Need to Know.mkv')))
  assert.ok(has(path.join(dirs.movies, 'Inception (2010).mkv')))
  const look = path.join(dirs.inbox, '_Needs a look', 'Mystery Clip.mp4')
  assert.ok(has(look), 'unsure file waits under _Needs a look')
  assert.equal(videosUnder(dirs.inbox).length, 1)

  // It is on the existing "Titles to check" list, tied back to the Inbox.
  const queued = titleMatch.getReviewQueue(store)['Mystery Clip.mp4']
  assert.ok(queued && queued.inbox && queued.inbox.id)
  const st = inbox.status()
  assert.equal(st.counts.needsLook, 1)
  assert.equal(st.counts.sortedToday, 2)
  assert.match(st.recent.find((r) => r.kind === 'episode').text, /Moved "house\.s02e11.*" → House › Season 02/)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].body, 'Sorted 1 episode and 1 film; 1 needs a look')
  assert.equal(sorted.find((s) => s.kind === 'film').tmdb.id, 27205)

  // One click: "This is: The Mystery Clip Show (2003)".
  const entry = st.needsLook[0]
  assert.ok(entry.candidates.some((c) => c.id === 2))
  const r = await inbox.fileAs(entry.id, { tmdbId: 2 })
  assert.equal(r.ok, true)
  assert.ok(has(path.join(dirs.movies, 'The Mystery Clip Show (2003).mp4')))
  assert.ok(!has(look))
  assert.equal(titleMatch.getReviewQueue(store)['Mystery Clip.mp4'], undefined)
  assert.equal(inbox.status().counts.needsLook, 0)
})

test('routing without a TMDB key: clear SxxEyy episodes are filed, films wait', async (t) => {
  const { dirs, inbox } = await setup(t, { api: null })
  await put(path.join(dirs.inbox, 'Breaking.Bad.S01E01.mkv'))
  await put(path.join(dirs.inbox, 'Arrival.mkv'))
  await put(path.join(dirs.inbox, 'blue.bloods.401.hdtv.mp4'))
  await inbox.scanOnce()
  assert.ok(has(path.join(dirs.tv, 'Breaking Bad', 'Season 01', 'Breaking Bad - S01E01.mkv')))
  assert.ok(has(path.join(dirs.inbox, '_Needs a look', 'Arrival.mkv')))
  assert.ok(has(path.join(dirs.inbox, '_Needs a look', 'blue.bloods.401.hdtv.mp4')), 'a bare 401 code is not trusted without TMDB')
  // TMDB unreachable: nothing is guessed either.
  const offline = { get: async () => ({ ok: false, status: 0 }) }
  const second = await setup(t, { api: offline })
  await put(path.join(second.dirs.inbox, 'Inception.2010.mkv'))
  await inbox.stop()
  await second.inbox.scanOnce()
  assert.ok(has(path.join(second.dirs.inbox, '_Needs a look', 'Inception.2010.mkv')))
  assert.equal(second.inbox.status().needsLook[0].reason, 'tmdb_unreachable')
})

test('stable check: waits for size/mtime to settle and for the copy to let go of the file', async (t) => {
  let clock = 1_000_000
  let locked = true
  const ops = {
    open: async (p, flags) => {
      if (flags === 'r+' && locked) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return fsp.open(p, flags)
    }
  }
  const { dirs, inbox } = await setup(t, { inbox: { stableMs: 30000, now: () => clock, ops } })
  const f = await put(path.join(dirs.inbox, 'Inception.2010.mkv'), 'part')
  await inbox.scanOnce()
  assert.ok(has(f), 'just appeared: not touched')
  assert.equal(inbox.status().counts.waitingForCopy, 1)
  clock += 20000
  await fsp.appendFile(f, 'more') // still growing
  await inbox.scanOnce()
  clock += 20000
  await inbox.scanOnce()
  assert.ok(has(f), 'grew 20 s ago: still waiting')
  clock += 15000
  await inbox.scanOnce()
  assert.ok(has(f), 'quiet for 35 s but still open by the copier')
  locked = false
  await inbox.scanOnce()
  assert.ok(!has(f))
  assert.ok(has(path.join(dirs.movies, 'Inception (2010).mkv')))
  // Partial downloads are never touched at all.
  const part = await put(path.join(dirs.inbox, 'Something.mkv.part'))
  clock += 60000
  await inbox.scanOnce()
  clock += 60000
  await inbox.scanOnce()
  assert.ok(has(part))
})

test('same drive: a plain rename, no copy', async (t) => {
  const seenFlags = []
  const ops = { open: async (p, flags) => { seenFlags.push(flags); return fsp.open(p, flags) } }
  const { dirs, inbox } = await setup(t, { inbox: { ops } })
  await put(path.join(dirs.inbox, 'Inception.2010.mkv'), 'x'.repeat(1000))
  await inbox.scanOnce()
  assert.ok(has(path.join(dirs.movies, 'Inception (2010).mkv')))
  assert.ok(!seenFlags.includes('wx'), 'nothing was copied')
})

test('cross drive: copy, verify, then remove the original; a failure mid-copy keeps the original', async (t) => {
  const big = Buffer.alloc(9 * 1024 * 1024 + 123)
  for (let i = 0; i < big.length; i += 4096) big[i] = i % 251
  let failWrites = false
  const ops = {
    rename: async (a, b) => {
      // Moving OUT of the Inbox behaves like another drive.
      if (a.includes('Beebo Inbox') && !b.includes('Beebo Inbox')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return fsp.rename(a, b)
    },
    open: async (p, flags) => {
      const fh = await fsp.open(p, flags)
      if (flags !== 'wx' || !failWrites) return fh
      let writes = 0
      return {
        read: (...a) => fh.read(...a),
        stat: () => fh.stat(),
        sync: () => fh.sync(),
        close: () => fh.close(),
        write: async (...a) => { if (++writes > 1) throw Object.assign(new Error('USB unplugged'), { code: 'EIO' }); return fh.write(...a) }
      }
    }
  }
  const { dirs, inbox } = await setup(t, { inbox: { ops } })
  const src = await put(path.join(dirs.inbox, 'Inception.2010.mkv'), big)
  failWrites = true
  await inbox.scanOnce()
  assert.ok(has(src), 'original kept after a failed copy')
  assert.deepEqual(await fsp.readFile(src), big)
  assert.ok(!has(path.join(dirs.movies, 'Inception (2010).mkv')))
  assert.equal(listAll(dirs.movies).length, 0, 'no half-written temp file left behind')
  assert.equal(inbox.status().recent[0].kind, 'error')

  failWrites = false
  await inbox.sortNow() // "Sort now" clears the retry wait
  const dest = path.join(dirs.movies, 'Inception (2010).mkv')
  assert.ok(has(dest))
  assert.deepEqual(await fsp.readFile(dest), big)
  assert.ok(!has(src), 'original removed only after the verified copy')
})

test('safeMove: never overwrites, and a checksum mismatch keeps the original', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-inbox-move-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const a = await put(path.join(root, 'a.mkv'), 'AAAA')
  const b = await put(path.join(root, 'dest', 'b.mkv'), 'BBBB')
  await assert.rejects(inboxMod.safeMove(a, b), { code: 'EEXIST' })
  assert.equal(await fsp.readFile(b, 'utf8'), 'BBBB')
  const corrupt = {
    rename: async (x, y) => { if (!y.endsWith('.beebo-copying') && x.endsWith('a.mkv')) throw Object.assign(new Error('x'), { code: 'EXDEV' }); return fsp.rename(x, y) },
    open: async (p, flags) => {
      const fh = await fsp.open(p, flags)
      if (flags !== 'wx') return fh
      return { read: (...x) => fh.read(...x), stat: () => fh.stat(), sync: () => fh.sync(), close: () => fh.close(), write: (buf, off, len, pos) => fh.write(Buffer.from('ZZZZ'), 0, len, pos) }
    }
  }
  const c = path.join(root, 'dest', 'c.mkv')
  await assert.rejects(inboxMod.safeMove(a, c, { ops: Object.assign({}, { stat: fsp.stat, mkdir: fsp.mkdir, unlink: fsp.unlink }, corrupt), freeSpace: null }), { code: 'BEEBO_VERIFY' })
  assert.equal(await fsp.readFile(a, 'utf8'), 'AAAA')
  assert.ok(!has(c) && !has(c + '.beebo-copying'))
})

test('duplicates go to _Duplicates; a different file with the same name keeps both and is flagged', async (t) => {
  const { dirs, inbox } = await setup(t)
  await put(path.join(dirs.movies, 'Inception (2010).mkv'), 'same-bytes')
  await put(path.join(dirs.inbox, 'Inception.2010.mkv'), 'same-bytes')
  await inbox.scanOnce()
  assert.ok(has(path.join(dirs.inbox, '_Duplicates', 'Inception.2010.mkv')))
  assert.equal(await fsp.readFile(path.join(dirs.movies, 'Inception (2010).mkv'), 'utf8'), 'same-bytes')

  await put(path.join(dirs.inbox, 'Inception 2010 Directors Cut.mkv'), 'longer-different-bytes')
  await inbox.scanOnce()
  assert.equal(await fsp.readFile(path.join(dirs.movies, 'Inception (2010).mkv'), 'utf8'), 'same-bytes', 'never overwritten')
  assert.ok(has(path.join(dirs.movies, 'Inception (2010) (2).mkv')))
  const flagged = inbox.status().needsLook.find((n) => n.type === 'clash')
  assert.ok(flagged)
  assert.equal(inbox.status().counts.duplicates, 1)
  assert.equal((await inbox.fileAs(flagged.id, { kind: 'keep' })).ok, true)
  assert.equal(inbox.status().counts.needsLook, 0)
})

test('sidecars travel with their video and are renamed to match', async (t) => {
  const { dirs, inbox } = await setup(t)
  await put(path.join(dirs.inbox, 'Inception.2010.1080p.mkv'))
  await put(path.join(dirs.inbox, 'Inception.2010.1080p.en.srt'), 'subs')
  await put(path.join(dirs.inbox, 'Inception.2010.1080p.en.forced.srt'), 'forced')
  await put(path.join(dirs.inbox, 'Inception.2010.1080p.nfo'), 'nfo')
  // A whole folder dropped in, subtitles in Subs\ and a poster.jpg.
  const folder = path.join(dirs.inbox, 'House.S02E11.720p')
  await put(path.join(folder, 'house.s02e11.720p.mkv'))
  await put(path.join(folder, 'Subs', 'English.srt'), 'eng')
  await put(path.join(folder, 'poster.jpg'), 'img')
  await inbox.scanOnce()
  assert.ok(has(path.join(dirs.movies, 'Inception (2010).mkv')))
  assert.equal(await fsp.readFile(path.join(dirs.movies, 'Inception (2010).en.srt'), 'utf8'), 'subs')
  assert.equal(await fsp.readFile(path.join(dirs.movies, 'Inception (2010).en.forced.srt'), 'utf8'), 'forced')
  assert.ok(has(path.join(dirs.movies, 'Inception (2010).nfo')))
  const season = path.join(dirs.tv, 'House', 'Season 02')
  assert.ok(has(path.join(season, 'House - S02E11 - Need to Know.mkv')))
  assert.equal(await fsp.readFile(path.join(season, 'House - S02E11 - Need to Know.English.srt'), 'utf8'), 'eng')
  assert.ok(has(path.join(season, 'House - S02E11 - Need to Know-poster.jpg')))
  assert.ok(!has(folder), 'the emptied drop folder is tidied away')
})

test('a Subs/Subtitles folder is found whatever its capitalisation (Linux file systems care)', async (t) => {
  const { dirs, inbox } = await setup(t)
  const folder = path.join(dirs.inbox, 'Arrival.2016.1080p')
  await put(path.join(folder, 'Arrival.2016.1080p.mkv'))
  await put(path.join(folder, 'SUBTITLES', 'en.srt'), 'eng')
  await inbox.scanOnce()
  assert.ok(has(path.join(dirs.movies, 'Arrival (2016).mkv')))
  assert.equal(await fsp.readFile(path.join(dirs.movies, 'Arrival (2016).en.srt'), 'utf8'), 'eng')
})

test('samples, trailers, extras and junk are set aside in _ignored, never deleted', async (t) => {
  const { dirs, inbox } = await setup(t)
  const ign = path.join(dirs.inbox, '_ignored')
  await put(path.join(dirs.inbox, 'Film', 'sample.mkv'), 'tiny')
  await put(path.join(dirs.inbox, 'Inception-trailer.mp4'))
  await put(path.join(dirs.inbox, 'Film', 'Featurettes', 'Making Of.mkv'))
  await put(path.join(dirs.inbox, 'readme.txt'), 'hi')
  await put(path.join(dirs.inbox, 'Get more movies.url'), 'x')
  await put(path.join(dirs.inbox, 'setup.exe'), 'x')
  await put(path.join(dirs.inbox, 'cover.jpg'), 'x')
  await put(path.join(dirs.inbox, 'desktop.ini'), 'x')
  await inbox.scanOnce()
  for (const rel of [['Film', 'sample.mkv'], ['Inception-trailer.mp4'], ['Film', 'Featurettes', 'Making Of.mkv'], ['readme.txt'], ['Get more movies.url'], ['setup.exe'], ['cover.jpg']]) {
    assert.ok(has(path.join(ign, ...rel)), rel.join('/'))
  }
  assert.ok(has(path.join(dirs.inbox, 'desktop.ini')), 'system files are left alone')
  assert.equal(listAll(dirs.movies).length, 0)
  // A big file called "sample" is not a sample clip.
  assert.equal(inboxMod.extraReason('The Sample.2019.mkv', 2 * 1024 * 1024 * 1024), null)
  assert.equal(inboxMod.extraReason('Trailer.Park.Boys.S01E01.mkv', 10), null)
})

test('episodes join an existing show folder, matched case-insensitively', async (t) => {
  const { dirs, inbox } = await setup(t, { api: null })
  await fsp.mkdir(path.join(dirs.tv, 'the office', 'Season 1'), { recursive: true })
  await put(path.join(dirs.inbox, 'The.Office.S01E05.mkv'))
  await put(path.join(dirs.inbox, 'THE OFFICE - 1x06.mkv'))
  await inbox.scanOnce()
  assert.ok(has(path.join(dirs.tv, 'the office', 'Season 1', 'the office - S01E05.mkv')))
  assert.ok(has(path.join(dirs.tv, 'the office', 'Season 1', 'the office - S01E06.mkv')))
  assert.equal(fs.readdirSync(dirs.tv).length, 1, 'no second "The Office" folder')

  // With TMDB, the show's TMDB id finds a differently named folder.
  const withId = await setup(t, { inbox: { tvIdOfShow: (display) => (display === 'Office US' ? 2316 : null) } })
  await fsp.mkdir(path.join(withId.dirs.tv, 'Office US'), { recursive: true })
  await put(path.join(withId.dirs.inbox, 'the.office.us.s03e01.mkv'))
  await withId.inbox.scanOnce()
  assert.ok(has(path.join(withId.dirs.tv, 'Office US', 'Season 03', 'Office US - S03E01.mkv')))
})

test('an existing show folder with a year files episodes under the clean show title', async (t) => {
  // Sam's library: TVShows/house-2004 holds "House S01E06.mp4"; new episodes came out as
  // "house-2004 - S02E21 - Euphoria (2).mp4". The folder is kept, the name is the show's title.
  const { dirs, inbox } = await setup(t, { api: null })
  await fsp.mkdir(path.join(dirs.tv, 'house-2004'), { recursive: true })
  await put(path.join(dirs.tv, 'house-2004', 'House S02E20.mp4'))
  await put(path.join(dirs.inbox, '0412142-house-2004.S2.E21.720p.mp4'))
  await inbox.scanOnce()
  const filed = listAll(path.join(dirs.tv, 'house-2004')).map((f) => path.basename(f))
  assert.ok(filed.includes('house - S02E21.mp4'), filed.join(', '))
  assert.ok(!filed.some((f) => /^house-2004 - /.test(f)), 'no raw folder name in the file name')
  assert.equal(fs.readdirSync(dirs.tv).length, 1, 'no second House folder')
})

test('not enough free space: the file stays put and the reason is shown', async (t) => {
  const ops = { rename: async (a, b) => { if (a.includes('Beebo Inbox') && !b.includes('Beebo Inbox')) throw Object.assign(new Error('x'), { code: 'EXDEV' }); return fsp.rename(a, b) } }
  const { dirs, inbox } = await setup(t, { inbox: { ops, freeSpace: async () => 1024 } })
  const f = await put(path.join(dirs.inbox, 'Inception.2010.mkv'), 'x'.repeat(5000))
  await inbox.scanOnce()
  assert.ok(has(f))
  assert.equal(listAll(dirs.movies).length, 0)
  const st = inbox.status()
  assert.equal(st.problem.code, 'no_space')
  assert.match(st.problem.text, /Not enough free space to sort "Inception\.2010\.mkv"/)
})

test('undo: "Undo last sort" and "Put it back" restore the original paths', async (t) => {
  const { dirs, inbox } = await setup(t)
  const a = await put(path.join(dirs.inbox, 'Drop', 'Inception.2010.mkv'))
  const sub = await put(path.join(dirs.inbox, 'Drop', 'Inception.2010.en.srt'), 's')
  const b = await put(path.join(dirs.inbox, 'house.s02e11.mkv'))
  await inbox.scanOnce()
  assert.ok(!has(a) && !has(b))
  const r = await inbox.undoLast()
  assert.equal(r.putBack, 2)
  assert.ok(has(a) && has(sub) && has(b))
  assert.equal(listAll(dirs.movies).length + listAll(dirs.tv).length, 0)
  // Put back files are held, not sorted straight back out again.
  await inbox.scanOnce()
  assert.ok(has(a) && has(b))
  assert.equal(inbox.status().counts.held, 2)
  // "Sort now" releases them; then a single item can be put back.
  await inbox.sortNow()
  assert.ok(!has(b))
  const item = inbox.status().recent.find((x) => x.kind === 'episode' && !x.undone)
  const back = await inbox.putBack(item.undoId)
  assert.equal(back.ok, true)
  assert.ok(has(b))
  assert.equal((await inbox.putBack(item.undoId)).error, 'already_put_back')
})

test('a burst of 200 files is filed without blocking the event loop', async (t) => {
  const { dirs, inbox } = await setup(t, { api: null })
  for (let i = 1; i <= 200; i++) {
    const s = 1 + (i % 5)
    await put(path.join(dirs.inbox, `Show ${1 + (i % 3)}.S0${s}E${String(i).padStart(3, '0')}.mkv`), 'v' + i)
  }
  let maxLag = 0
  let last = Date.now()
  const timer = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 5); last = n }, 5)
  const started = Date.now()
  await inbox.scanOnce()
  clearInterval(timer)
  assert.equal(videosUnder(dirs.tv).length, 200)
  assert.equal(videosUnder(dirs.inbox).length, 0)
  assert.ok(maxLag < 250, `event loop was blocked for ${maxLag} ms (took ${Date.now() - started} ms)`)
})

test('no failure path ever deletes a video', async (t) => {
  let mode = 'eperm'
  const ops = {
    rename: async (a, b) => {
      if (mode === 'eperm') throw Object.assign(new Error('denied'), { code: 'EPERM' })
      if (mode === 'exdev-fail-unlink' && !a.endsWith('.beebo-copying')) throw Object.assign(new Error('x'), { code: 'EXDEV' })
      return fsp.rename(a, b)
    },
    unlink: async (p) => {
      if (mode === 'exdev-fail-unlink' && !p.endsWith('.beebo-copying')) throw Object.assign(new Error('locked'), { code: 'EBUSY' })
      return fsp.unlink(p)
    }
  }
  const { dirs, inbox } = await setup(t, { inbox: { ops, retryErrorMs: 0 } })
  const names = ['Inception.2010.mkv', 'house.s02e11.mkv', 'Mystery Clip.mp4']
  for (const n of names) await put(path.join(dirs.inbox, n), n)
  const count = () => videosUnder(dirs.root).length
  await inbox.scanOnce()
  assert.equal(count(), 3, 'rename refused: everything still there')
  mode = 'exdev-fail-unlink'
  await inbox.scanOnce()
  // Copies verified and placed, originals could not be removed: both kept.
  assert.ok(count() >= 3)
  for (const n of names.slice(0, 2)) assert.ok(has(path.join(dirs.inbox, n)))
  mode = 'normal'
  await inbox.scanOnce()
  assert.ok(count() >= 3, 'the kept originals went to _Duplicates, not the bin')
  assert.ok(has(path.join(dirs.inbox, '_Duplicates', 'Inception.2010.mkv')), JSON.stringify([listAll(dirs.root), inbox.status().recent], null, 1))
  // Undo of everything still loses nothing.
  while ((await inbox.undoLast()).ok) {}
  assert.ok(count() >= 3)
})

test('refuses to run when the Inbox overlaps a library folder, and never touches files outside it', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-inbox-overlap-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const movies = path.join(root, 'Movies')
  const inside = path.join(movies, 'Beebo Inbox')
  await put(path.join(inside, 'Inception.2010.mkv'))
  const inbox = inboxMod.createInbox({ store: fakeStore(), getInboxDir: () => inside, getMoviesDir: () => movies, getTvShowsDir: () => path.join(root, 'TV'), stableMs: 0, undoLogPath: path.join(root, 'u.jsonl') })
  await inbox.scanOnce()
  assert.ok(has(path.join(inside, 'Inception.2010.mkv')))
  assert.equal(inbox.status().problem.code, 'overlaps_library')
  assert.equal(inboxMod.isInside(path.join(root, 'Beebo Inbox2', 'x.mkv'), path.join(root, 'Beebo Inbox')), false)
})

test('web admin: Inbox tab, and "Titles to check" files an Inbox item when a title is picked', async (t) => {
  const https = require('node:https')
  const { execFileSync } = require('node:child_process')
  const store = fakeStore({
    authUsers: [{ id: 'u-owner', name: 'Nick', username: 'nick', email: '', status: 'approved', isAdmin: true, createdAt: 1, passwordHash: 'scrypt$salt$x', code: null, codeHash: null }]
  })
  const { dirs, inbox } = await setup(t, { store })
  let cert = null
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dirs.root, 'key.pem'), '-out', path.join(dirs.root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
    cert = { cert: fs.readFileSync(path.join(dirs.root, 'cert.pem'), 'utf8'), key: fs.readFileSync(path.join(dirs.root, 'key.pem'), 'utf8') }
  } catch {}
  if (!cert) { t.skip('openssl not available'); return }
  const server = localRequire('./electron/streamServer')
  const auth = localRequire('./electron/auth')
  auth.forgetSecrets(); server.forgetSecrets()
  const port = testPort()
  const info = server.startStreamServer({ port, store, inbox, getMoviesDir: () => dirs.movies, getTvShowsDir: () => dirs.tv, getAllMoviesDirs: () => [dirs.movies], getAllTvShowsDirs: () => [dirs.tv], getTmdbCacheDir: () => '', log: () => {} })
  t.after(() => { try { info.close() } catch {} })
  assert.equal(info.applyCertificate(cert).ok, true)
  const request = (method, p, body) => new Promise((resolve, reject) => {
    const headers = { Cookie: `beebo_session=${auth.signSession(store, 'u-owner')}` }
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const req = https.request({ host: '127.0.0.1', port: info.port, method, path: p, headers, rejectUnauthorized: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body) req.write(new URLSearchParams(body).toString())
    req.end()
  })
  for (let i = 0; i < 50; i++) { try { await request('GET', '/login'); break } catch { await new Promise((r) => setTimeout(r, 100)) } }

  await put(path.join(dirs.inbox, 'Mystery Clip.mp4'))
  await inbox.scanOnce()
  const page = await request('GET', '/admin?tab=inbox')
  assert.equal(page.status, 200)
  assert.match(page.body, /Needs a look \(1\)/)
  assert.match(page.body, /This is: The Mystery Clip Show \(2003\)/)
  const titles = await request('GET', '/admin?tab=titles')
  assert.match(titles.body, /Waiting in your Beebo Inbox/)

  const pick = await request('POST', '/admin/titles/pick', { tab: 'titles', fileName: 'Mystery Clip.mp4', tmdbId: '2' })
  assert.equal(pick.status, 303)
  assert.ok(has(path.join(dirs.movies, 'The Mystery Clip Show (2003).mp4')))

  const undo = await request('POST', '/admin/inbox/undo-last', { tab: 'inbox' })
  assert.equal(undo.status, 303)
  assert.ok(has(path.join(dirs.inbox, '_Needs a look', 'Mystery Clip.mp4')), 'put back where it was, waiting for a look again')
  assert.equal(inbox.status().counts.needsLook, 1)
})

test('the old "New files drop folder" becomes the Inbox, once', async (t) => {
  // A configured drop folder is adopted, and files already in it get sorted.
  const { dirs, store } = await setup(t)
  const legacy = path.join(dirs.root, 'NewFiles')
  await put(path.join(legacy, 'Inception.2010.mkv'))
  store.set('newFilesDir', legacy)
  const r = inboxMod.migrateLegacyDropFolder(store, { legacyDefaults: [] })
  assert.deepEqual(r, { migrated: true, dir: legacy })
  assert.equal(store.get('inboxDir'), legacy)
  assert.equal(store.get('newFilesDir'), legacy, 'the old key is left for backups and older phone apps')
  const inbox = inboxMod.createInbox({ store, getInboxDir: () => store.get('inboxDir'), getMoviesDir: () => dirs.movies, getTvShowsDir: () => dirs.tv, getTmdbApi: () => fakeApi(), stableMs: 0, freeSpace: null, undoLogPath: path.join(dirs.root, 'm.jsonl') })
  await inbox.scanOnce()
  assert.ok(has(path.join(dirs.movies, 'Inception (2010).mkv')))

  // Only once: a later choice of Inbox is never overwritten.
  store.set('inboxDir', path.join(dirs.root, 'Chosen later'))
  assert.equal(inboxMod.migrateLegacyDropFolder(store).migrated, false)
  assert.equal(store.get('inboxDir'), path.join(dirs.root, 'Chosen later'))

  // An Inbox already chosen wins over a drop folder.
  const s2 = fakeStore({ inboxDir: 'X:\\Inbox', newFilesDir: 'X:\\NewFiles' })
  assert.equal(inboxMod.migrateLegacyDropFolder(s2).migrated, false)
  assert.equal(s2.get('inboxDir'), 'X:\\Inbox')

  // Never configured: an old default drop folder is used only if it exists.
  const s3 = fakeStore()
  assert.equal(inboxMod.migrateLegacyDropFolder(s3, { legacyDefaults: ['Q:\\Beebo\\NewFiles'], exists: () => false }).migrated, false)
  assert.equal(s3.get('inboxDir'), undefined, 'falls back to "Beebo Inbox" next to Movies')
  const s4 = fakeStore()
  assert.equal(inboxMod.migrateLegacyDropFolder(s4, { legacyDefaults: ['Q:\\Beebo\\NewFiles', 'Q:\\MovieAPP\\NewFiles'], exists: (p) => p.includes('MovieAPP') }).dir, 'Q:\\MovieAPP\\NewFiles')
})

test('names: Windows-illegal characters and reserved names', () => {
  assert.equal(inboxMod.sanitizeName('Star Wars: Episode IV'), 'Star Wars - Episode IV')
  assert.equal(inboxMod.sanitizeName('What? "Why" <How> a|b*c.'), 'What Why How abc')
  assert.equal(inboxMod.sanitizeName('CON'), 'CON_')
  assert.ok(inboxMod.sanitizeName('x'.repeat(400)).length <= 150)
  assert.equal(inboxMod.batchSummary({ episodes: 12, films: 3, needsLook: 2 }), 'Sorted 12 episodes and 3 films; 2 need a look')
})
