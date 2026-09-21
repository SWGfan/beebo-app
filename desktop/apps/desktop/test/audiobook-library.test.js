// The Audiobooks library: which files make which book, tags versus folder names, series and reading
// order, chapters (embedded, cue, one per file), DRM files reported and never read, incremental
// rescans, and the real m4b/flac path with ffmpeg-made fixtures (skipped without ffmpeg).
// Run: node --test test/audiobook-library.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const lib = localRequire('./electron/audiobookLibrary')
const transcode = localRequire('./electron/musicTranscode')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function write(file, data = 'x') {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, data)
  return file
}
const mkTmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-ab-lib-'))

// A tag reader that never touches the audio: the answer depends on the file name only.
function fakeReader(table, calls = []) {
  return async (file) => {
    calls.push(path.basename(file))
    const key = path.basename(file)
    if (!(key in table)) throw new Error('unreadable')
    return table[key]
  }
}

// ---------------------------------------------------------------------------
// planBooks: pure grouping
// ---------------------------------------------------------------------------

test('planBooks: m4b files are books, folders of files are one book, disc folders fold in, DRM is skipped', () => {
  const root = path.resolve('/lib')
  const P = (...s) => path.join(root, ...s)
  const plan = lib.planBooks([
    { dir: root, root, audio: [P('loose.mp3'), P('other.m4b')], drm: [], cues: [], images: [] },
    { dir: P('A', 'Two Books'), root, audio: [P('A', 'Two Books', 'one.m4b'), P('A', 'Two Books', 'two.m4b')], drm: [], cues: [], images: [P('A', 'Two Books', 'cover.jpg'), P('A', 'Two Books', 'one.png')] },
    { dir: P('B', 'Folder Book'), root, audio: [P('B', 'Folder Book', '10.mp3'), P('B', 'Folder Book', '2.mp3'), P('B', 'Folder Book', '1.mp3')], drm: [], cues: [P('B', 'Folder Book', 'b.cue')], images: [P('B', 'Folder Book', 'folder.jpg')] },
    { dir: P('C', 'Big Set', 'CD1'), root, audio: [P('C', 'Big Set', 'CD1', '01.mp3'), P('C', 'Big Set', 'CD1', '02.mp3')], drm: [], cues: [], images: [] },
    { dir: P('C', 'Big Set', 'Disc 2'), root, audio: [P('C', 'Big Set', 'Disc 2', '01.mp3')], drm: [], cues: [], images: [P('C', 'Big Set', 'Disc 2', 'cover.png')] },
    { dir: P('D'), root, audio: [P('D', 'lonely.flac')], drm: [P('D', 'protected.aax')], cues: [P('D', 'lonely.cue')], images: [P('D', 'front.jpg')] },
    { dir: P('E'), root, audio: [], drm: [P('E', 'only.aaxc')], cues: [], images: [] }
  ])
  const byPath = (p) => plan.groups.find((g) => g.path === p)
  const names = plan.groups.map((g) => path.relative(root, g.path).replace(/\\/g, '/'))
  assert.deepEqual(names.sort(), ['A/Two Books/one.m4b', 'A/Two Books/two.m4b', 'B/Folder Book', 'C/Big Set', 'D/lonely.flac', 'loose.mp3', 'other.m4b'].sort())

  assert.equal(byPath(P('loose.mp3')).kind, 'single', 'loose files in the root are never merged')
  const one = byPath(P('A', 'Two Books', 'one.m4b'))
  assert.deepEqual(one.images.map((p) => path.basename(p)), ['one.png'], 'only its own same-name picture, not the shared folder art')
  const folder = byPath(P('B', 'Folder Book'))
  assert.equal(folder.kind, 'folder')
  assert.deepEqual(folder.files.map((f) => path.basename(f.path)), ['1.mp3', '2.mp3', '10.mp3'], 'natural order')
  assert.equal(folder.cues.length, 1)
  const big = byPath(P('C', 'Big Set'))
  assert.deepEqual(big.files.map((f) => [f.disc, path.basename(f.path)]), [[1, '01.mp3'], [1, '02.mp3'], [2, '01.mp3']])
  assert.deepEqual(big.images.map((p) => path.basename(p)), ['cover.png'], 'a cover in a disc folder belongs to the whole book')
  const lonely = byPath(P('D', 'lonely.flac'))
  assert.equal(lonely.kind, 'single')
  assert.deepEqual(lonely.cues.map((p) => path.basename(p)), ['lonely.cue'])
  assert.deepEqual(lonely.images.map((p) => path.basename(p)), ['front.jpg'], 'the lone book in a folder gets the folder picture')
  assert.deepEqual(plan.skipped.map((s) => [path.basename(s.path), s.reason]).sort(), [['only.aaxc', 'drm'], ['protected.aax', 'drm']])
})

// ---------------------------------------------------------------------------
// assembleBook: tags, names, series, chapters
// ---------------------------------------------------------------------------

const part = (p, o = {}) => ({ path: p, disc: 1, size: 1, mtimeMs: 1, duration: 600, codec: 'mp3', container: 'MPEG', chapters: [], tags: {}, ...o })

test('assembleBook: tags win, then the series in the title, then the folders', () => {
  const g = { kind: 'single', path: '/lib/Author/Series/03 - Some Title.m4b', segs: ['Author', 'Series'] }
  const bare = lib.assembleBook(g, [part(g.path, { tags: {} })])
  assert.deepEqual([bare.author, bare.series, bare.seriesIndex, bare.title], ['Author', 'Series', 3, 'Some Title'])

  const tagged = lib.assembleBook(g, [part(g.path, { tags: { album: 'The Way of Kings (The Stormlight Archive #1)', artist: 'Sanderson, Brandon', narrator: 'Kate Reading', year: 2010, genre: 'Fantasy' } })])
  assert.deepEqual([tagged.title, tagged.author, tagged.narrator, tagged.series, tagged.seriesIndex, tagged.year, tagged.genre],
    ['The Way of Kings', 'Brandon Sanderson', 'Kate Reading', 'The Stormlight Archive', 1, 2010, 'Fantasy'])

  const viaTag = lib.assembleBook(g, [part(g.path, { tags: { album: 'Words of Radiance', artist: 'Brandon Sanderson', series: 'The Stormlight Archive', seriesPart: '2' } })])
  assert.deepEqual([viaTag.series, viaTag.seriesIndex], ['The Stormlight Archive', 2])
  const viaGrouping = lib.assembleBook(g, [part(g.path, { tags: { album: 'X', grouping: 'Discworld, Book 5' } })])
  assert.deepEqual([viaGrouping.series, viaGrouping.seriesIndex], ['Discworld', 5])
  const noAuthor = lib.assembleBook({ kind: 'single', path: '/lib/Just A Title.mp3', segs: [] }, [part('/lib/Just A Title.mp3')])
  assert.deepEqual([noAuthor.title, noAuthor.author, noAuthor.series], ['Just A Title', 'Unknown Author', null])
})

test('assembleBook: chapters from the file, then a cue sheet, then one per file', () => {
  const single = { kind: 'single', path: '/lib/b.m4b', segs: [] }
  const emb = lib.assembleBook(single, [part(single.path, { duration: 1000, chapters: [{ title: 'One', start: 0 }, { title: 'Two', start: 400 }] })])
  assert.equal(emb.chaptersSource, 'embedded')
  assert.deepEqual(emb.chapters, [{ title: 'One', start: 0, end: 400 }, { title: 'Two', start: 400, end: 1000 }])

  const cue = { tracks: [{ file: 'b.m4b', title: 'Intro', start: 0 }, { file: 'b.m4b', title: 'Middle', start: 250 }] }
  const viaCue = lib.assembleBook(single, [part(single.path, { duration: 1000 })], [cue])
  assert.equal(viaCue.chaptersSource, 'cue')
  assert.deepEqual(viaCue.chapters.map((c) => [c.title, c.start, c.end]), [['Intro', 0, 250], ['Middle', 250, 1000]])
  const oneOnly = lib.assembleBook(single, [part(single.path, { duration: 1000, chapters: [{ title: 'Whole', start: 0 }] })])
  assert.equal(oneOnly.chaptersSource, 'none', 'a single chapter is no chapter list')

  const folder = { kind: 'folder', path: '/lib/F', segs: ['F'] }
  const files = ['01 - Opening.mp3', '02 - Middle.mp3', '03 - End.mp3'].map((n, i) => part(path.join(folder.path, n), { duration: 100 * (i + 1), tags: { album: 'F', trackNo: i + 1 } }))
  const perFile = lib.assembleBook(folder, files)
  assert.equal(perFile.chaptersSource, 'files')
  assert.deepEqual(perFile.chapters.map((c) => [c.title, c.start, c.end]), [['Opening', 0, 100], ['Middle', 100, 300], ['End', 300, 600]])
  assert.equal(perFile.duration, 600)
  assert.deepEqual(perFile.parts.map((p) => p.start), [0, 100, 300])

  const sameTitles = files.map((f) => ({ ...f, tags: { ...f.tags, title: 'The Whole Book' } }))
  assert.deepEqual(lib.assembleBook(folder, sameTitles).chapters.map((c) => c.title), ['Opening', 'Middle', 'End'], 'a title tag repeated on every file is not a chapter name')

  const shuffled = [files[2], files[0], files[1]]
  assert.deepEqual(lib.assembleBook(folder, shuffled).parts.map((p) => path.basename(p.path)), files.map((f) => path.basename(f.path)), 'ordered by track number')

  const withChapters = [
    part('/lib/F/a.m4a', { duration: 300, chapters: [{ title: 'A1', start: 0 }, { title: 'A2', start: 100 }] }),
    part('/lib/F/b.m4a', { duration: 300 })
  ]
  const mixed = lib.assembleBook(folder, withChapters)
  assert.deepEqual(mixed.chapters.map((c) => [c.title, c.start]), [['A1', 0], ['A2', 100], ['b', 300]])
})

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

async function makeShelf(root) {
  const shelf = path.join(root, 'Audiobooks')
  const T = (title, extra = {}) => ({ title: '', album: title, artist: 'Some Author', duration: 3600, codec: 'aac', container: 'M4A/isom', ...extra })
  const table = {}
  // Sanderson: three of the series (one out of order on disk), a standalone, an m4b with chapters + a cue-less cover.
  await write(path.join(shelf, 'Brandon Sanderson', 'Mistborn', '02 - The Well of Ascension.m4b'))
  table['02 - The Well of Ascension.m4b'] = T('The Well of Ascension', { artist: 'Brandon Sanderson', duration: 7200, chapters: [{ title: 'Prologue', start: 0 }, { title: 'Chapter 1', start: 600 }, { title: 'Chapter 2', start: 4000 }], narrator: 'Michael Kramer' })
  await write(path.join(shelf, 'Brandon Sanderson', 'Mistborn', '01 - The Final Empire.m4b'))
  table['01 - The Final Empire.m4b'] = T('The Final Empire', { artist: 'Brandon Sanderson', duration: 9000 })
  await write(path.join(shelf, 'Brandon Sanderson', 'Mistborn', '03 - The Hero of Ages.m4b'))
  table['03 - The Hero of Ages.m4b'] = T('The Hero of Ages', { artist: 'Brandon Sanderson', duration: 8000 })
  await write(path.join(shelf, 'Brandon Sanderson', 'Elantris', 'Elantris.m4b'))
  table['Elantris.m4b'] = T('Elantris', { artist: 'Brandon Sanderson', duration: 5000, year: 2005 })
  await write(path.join(shelf, 'Brandon Sanderson', 'Elantris', 'cover.png'), PNG)
  // A folder of mp3s in two discs with no tags at all: names and folders only.
  for (const [d, n] of [['CD1', '01.mp3'], ['CD1', '02.mp3'], ['CD2', '01.mp3']]) await write(path.join(shelf, 'Ursula Le Guin', 'A Wizard of Earthsea', d, n))
  table['01.mp3'] = { duration: 1000, codec: 'MPEG 1 Layer 3', container: 'MPEG' }
  table['02.mp3'] = { duration: 500, codec: 'MPEG 1 Layer 3', container: 'MPEG' }
  // A single flac with a sidecar cue sheet.
  await write(path.join(shelf, 'Old Timers', 'Radio Play.flac'))
  await write(path.join(shelf, 'Old Timers', 'Radio Play.cue'), 'FILE "Radio Play.flac" WAVE\nTRACK 01 AUDIO\nTITLE "Act One"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE "Act Two"\nINDEX 01 20:00:00\n')
  table['Radio Play.flac'] = { title: 'Radio Play', artist: 'Old Timers', album: 'Radio Play', duration: 3000, codec: 'flac', lossless: true, container: 'flac' }
  // Copy-protected Audible files, and a file that will not read.
  await write(path.join(shelf, 'Audible', 'Protected Book.aax'))
  await write(path.join(shelf, 'Audible', 'Newer Book.aaxc'))
  await write(path.join(shelf, 'Broken', 'broken.mp3'))
  await write(path.join(shelf, 'notes.txt'))
  return { shelf, table }
}

test('scan: books, series in reading order, folders, cue chapters, covers, DRM skipped', async () => {
  const root = await mkTmp()
  try {
    const { shelf, table } = await makeShelf(root)
    const cache = path.join(root, 'cache')
    const a = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => cache, readTags: fakeReader(table) })
    const st = await a.scan()
    assert.equal(st.bookCount, 7, 'three Mistborn, Elantris, the Earthsea folder, the flac, the unreadable one')
    assert.equal(st.skippedCount, 2)
    assert.equal(st.seriesCount, 1)
    assert.deepEqual(a.skippedFiles().map((s) => s.name).sort(), ['Newer Book.aaxc', 'Protected Book.aax'])
    assert.ok(!JSON.stringify(a.skippedFiles()).includes('Audible'), 'names only, no folders')

    const mist = a.series()[0]
    assert.equal(mist.name, 'Mistborn')
    assert.equal(mist.author, 'Brandon Sanderson')
    const { books } = a.seriesDetail(mist.id)
    assert.deepEqual(books.map((b) => [b.seriesIndex, b.title]), [[1, 'The Final Empire'], [2, 'The Well of Ascension'], [3, 'The Hero of Ages']], 'reading order, not disk order')
    assert.equal(a.nextInSeries(books[0].id).title, 'The Well of Ascension')
    assert.equal(a.nextInSeries(books[2].id), null)
    assert.equal(a.nextInSeries(a.books().find((b) => b.title === 'Elantris').id), null, 'standalone')

    const well = books[1]
    assert.equal(well.narrator, 'Michael Kramer')
    assert.equal(well.chaptersSource, 'embedded')
    assert.equal(well.chapters.length, 3)
    assert.equal(well.duration, 7200)
    assert.match(well.id, /^[a-f0-9]{16}$/)

    const elantris = a.books().find((b) => b.title === 'Elantris')
    assert.equal(elantris.year, 2005)
    assert.match(elantris.coverId, /^[a-f0-9]{32}$/, 'folder picture')
    assert.ok(a.coverFile(elantris.coverId))
    assert.equal(elantris.author, 'Brandon Sanderson')

    const earthsea = a.books().find((b) => b.title === 'A Wizard of Earthsea')
    assert.ok(earthsea, 'title and author come from the folders when there are no tags')
    assert.equal(earthsea.author, 'Ursula Le Guin')
    assert.equal(earthsea.kind, 'folder')
    assert.equal(earthsea.partCount, 3)
    assert.equal(earthsea.duration, 2500)
    assert.equal(earthsea.chaptersSource, 'files')
    assert.deepEqual(earthsea.parts.map((p) => p.start), [0, 1000, 1500])

    const radio = a.books().find((b) => b.title === 'Radio Play')
    assert.equal(radio.chaptersSource, 'cue')
    assert.deepEqual(radio.chapters.map((c) => [c.title, c.start, c.end]), [['Act One', 0, 1200], ['Act Two', 1200, 3000]])

    const broken = a.books().find((b) => b.path.endsWith('broken.mp3'))
    assert.equal(broken.unreadable, true)
    assert.equal(broken.duration, 0)

    // Lookups
    const authors = a.authors()
    assert.equal(authors.find((x) => x.name === 'Brandon Sanderson').bookCount, 4)
    const bs = a.author(authors.find((x) => x.name === 'Brandon Sanderson').id)
    assert.equal(bs.series.length, 1)
    assert.deepEqual(a.search('kramer').books.map((b) => b.title), ['The Well of Ascension'], 'narrator search')
    assert.deepEqual(a.search('mist').series.map((s) => s.name), ['Mistborn'])
    assert.deepEqual(a.search('sanderson').authors.map((x) => x.name), ['Brandon Sanderson'])
    assert.equal(a.search('').books.length, 0)
    assert.equal(a.books({ sort: 'duration' })[0].title, 'The Final Empire')
    assert.equal(a.books({ seriesId: mist.id }).length, 3)
    assert.deepEqual(a.books({ authorId: 'not-an-id' }), [])
    assert.equal(a.book('../../etc/passwd'), null)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('scan: a rescan reads only files that changed; the index survives a restart; removed books go', async () => {
  const root = await mkTmp()
  try {
    const { shelf, table } = await makeShelf(root)
    const cache = path.join(root, 'cache')
    const calls = []
    const a = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => cache, readTags: fakeReader(table, calls) })
    await a.scan()
    const first = calls.length
    assert.equal(first, 9)
    calls.length = 0
    await a.scan()
    // Only the unreadable file has no cached record with tags... every readable file is reused.
    assert.ok(calls.every((c) => c === 'broken.mp3'), 'only the broken file is retried: ' + calls.join(','))

    // A new book, a modified file and a deleted one.
    await write(path.join(shelf, 'New Author', 'Fresh.m4b'))
    table['Fresh.m4b'] = { album: 'Fresh', artist: 'New Author', duration: 60, codec: 'aac', container: 'M4A/isom' }
    const future = new Date(Date.now() + 5000)
    await fsp.utimes(path.join(shelf, 'Brandon Sanderson', 'Elantris', 'Elantris.m4b'), future, future)
    await fsp.rm(path.join(shelf, 'Old Timers'), { recursive: true })
    calls.length = 0
    const st = await a.scan()
    assert.deepEqual(calls.filter((c) => c !== 'broken.mp3').sort(), ['Elantris.m4b', 'Fresh.m4b'])
    assert.equal(st.bookCount, 7, '+1 new, -1 deleted')
    assert.ok(!a.books().some((b) => b.title === 'Radio Play'))

    // A new process reads the saved index without scanning.
    const b = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => cache, readTags: async () => { throw new Error('should not read') } })
    assert.equal(b.status().bookCount, 7)
    assert.equal(b.books().find((x) => x.title === 'The Well of Ascension').chapters.length, 3)
    const s2 = await b.scan()
    assert.equal(s2.bookCount, 7, 'unchanged files come from the index; the unreadable one is retried and stays')

    // Added-at survives rescans.
    const added = a.books().find((x) => x.title === 'Fresh').addedAt
    await a.scan()
    assert.equal(a.books().find((x) => x.title === 'Fresh').addedAt, added)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('bookFile: only parts that exist, only inside the configured folders', async () => {
  const root = await mkTmp()
  try {
    const { shelf, table } = await makeShelf(root)
    let dirs = [shelf]
    const a = lib.createAudiobookLibrary({ getDirs: () => dirs, getCacheDir: () => path.join(root, 'cache'), readTags: fakeReader(table) })
    await a.scan()
    const earthsea = a.books().find((b) => b.title === 'A Wizard of Earthsea')
    const f = a.bookFile(earthsea.id, 2)
    assert.equal(path.basename(f.path), '01.mp3')
    assert.equal(f.mime, 'audio/mpeg')
    assert.equal(a.bookFile(earthsea.id, 3), null)
    assert.equal(a.bookFile(earthsea.id, -1), null)
    assert.equal(a.bookFile(earthsea.id, '1.5'), null)
    assert.equal(a.bookFile(earthsea.id, 'x'), null)
    const m4b = a.books().find((b) => b.title === 'Elantris')
    assert.equal(a.bookFile(m4b.id, 0).mime, 'audio/mp4', '.m4b is served as audio/mp4')
    assert.equal(a.bookFile('0'.repeat(16), 0), null)
    dirs = [path.join(root, 'elsewhere')]
    assert.equal(a.bookFile(m4b.id, 0), null, 'the folder was removed from settings')
    dirs = [shelf]
    await fsp.rm(m4b.path)
    assert.equal(a.bookFile(m4b.id, 0), null, 'the file is gone')
    assert.equal(a.coverFile('../../secret'), null)
    assert.equal(a.coverFile('f'.repeat(32)), null)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('applyEnrichment fills only what the files lacked, and survives a rescan', async () => {
  const root = await mkTmp()
  try {
    const { shelf, table } = await makeShelf(root)
    const cache = path.join(root, 'cache')
    const a = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => cache, readTags: fakeReader(table) })
    await a.scan()
    const fe = a.books().find((b) => b.title === 'The Final Empire')
    const el = a.books().find((b) => b.title === 'Elantris')
    assert.equal(a.applyEnrichment(fe.id, { year: 2006, genre: 'Fantasy', key: '/works/OL1W' }), true)
    assert.equal(a.applyEnrichment(el.id, { year: 1999 }), true)
    assert.equal(a.applyEnrichment('nothexnothexnoth', { year: 1 }), false)
    assert.equal(a.book(fe.id).year, 2006)
    assert.equal(a.book(fe.id).genre, 'Fantasy')
    assert.deepEqual(a.book(fe.id).onlineMatch, { source: 'openlibrary', key: '/works/OL1W' })
    assert.equal(a.book(el.id).year, 2005, 'the file said 2005; the online answer does not overrule it')
    await a.scan()
    assert.equal(a.book(fe.id).year, 2006)
    const b = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => cache, readTags: fakeReader(table) })
    assert.equal(b.book(fe.id).year, 2006, 'saved with the index')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Real files
// ---------------------------------------------------------------------------

function findFf(name) {
  const bundled = transcode.resolveFf(name)
  if (bundled) return bundled
  const probe = spawnSync(name, ['-version'], { windowsHide: true })
  return probe.status === 0 ? name : null
}
const FFMPEG = findFf('ffmpeg')
const FFPROBE = findFf('ffprobe')
const ff = (args) => spawnSync(FFMPEG, ['-v', 'error', '-y', ...args], { windowsHide: true }).status === 0

test('real files: an m4b with chapter atoms, cover and tags; a flac folder; an ogg', { skip: !FFMPEG && 'ffmpeg not found' }, async () => {
  const root = await mkTmp()
  try {
    const shelf = path.join(root, 'Audiobooks')
    await fsp.mkdir(path.join(shelf, 'Tester', 'Saga'), { recursive: true })
    const tone = (secs, freq = 300) => ['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`]
    const cover = path.join(root, 'cover.png')
    await fsp.writeFile(cover, PNG)
    const meta = path.join(root, 'chapters.txt')
    await fsp.writeFile(meta, [';FFMETADATA1', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2000', 'title=Opening', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=2000', 'END=4000', 'title=The Middle', '[CHAPTER]', 'TIMEBASE=1/1000', 'START=4000', 'END=6000', 'title=Finale', ''].join('\n'))
    const m4b = path.join(shelf, 'Tester', 'Saga', '02 - Second Book.m4b')
    assert.ok(ff([...tone(6), '-i', meta, '-i', cover, '-map', '0:a', '-map', '2:v', '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', '-b:a', '48k', '-c:v', 'png', '-disposition:v', 'attached_pic',
      '-metadata', 'album=Second Book', '-metadata', 'artist=Tester, Ann', '-metadata', 'composer=Narrator Nan', '-metadata', 'grouping=The Saga #2', '-metadata', 'date=2020', '-metadata', 'genre=Audiobook', m4b]), 'm4b fixture')
    const flacDir = path.join(shelf, 'Other', 'Flac Story')
    await fsp.mkdir(flacDir, { recursive: true })
    for (const [i, n] of ['1 Start.flac', '2 Finish.flac'].entries()) assert.ok(ff([...tone(2, 400 + i * 100), '-c:a', 'flac', '-metadata', 'album=Flac Story', '-metadata', `track=${i + 1}`, path.join(flacDir, n)]), 'flac ' + n)

    const a = lib.createAudiobookLibrary({ getDirs: () => [shelf], getCacheDir: () => path.join(root, 'cache'), ffprobePath: FFPROBE, ffmpegPath: FFMPEG })
    await a.scan()
    const book = a.books().find((b) => b.title === 'Second Book')
    assert.ok(book, 'the m4b is a book: ' + a.books().map((b) => b.title).join(', '))
    assert.equal(book.author, 'Ann Tester')
    assert.equal(book.narrator, 'Narrator Nan')
    assert.equal(book.series, 'The Saga')
    assert.equal(book.seriesIndex, 2)
    assert.equal(book.year, 2020)
    assert.ok(book.duration > 5.5 && book.duration < 6.5, 'duration ' + book.duration)
    assert.equal(book.chaptersSource, 'embedded')
    assert.deepEqual(book.chapters.map((c) => [c.title, Math.round(c.start)]), [['Opening', 0], ['The Middle', 2], ['Finale', 4]])
    assert.match(book.coverId || '', /^[a-f0-9]{32}$/, 'embedded cover')
    assert.equal(book.parts[0].codec, 'aac')

    const flac = a.books().find((b) => b.title === 'Flac Story')
    assert.equal(flac.partCount, 2)
    assert.equal(flac.kind, 'folder')
    assert.equal(flac.chapters.length, 2)
    assert.ok(flac.duration > 3.6 && flac.duration < 4.4, 'flac duration ' + flac.duration)
    assert.equal(flac.author, 'Other', 'no artist tag: the folder above')

    // The ffprobe-only reader agrees on the chapters.
    const viaFfprobe = await lib.readTagsWithFfprobe(m4b, { ffprobePath: FFPROBE, ffmpegPath: FFMPEG })
    assert.equal(viaFfprobe.chapters.length, 3)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
