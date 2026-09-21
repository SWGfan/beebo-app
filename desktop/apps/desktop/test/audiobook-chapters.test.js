// Audiobook chapters and names: the m4b chapter atom, cue sheets, ffprobe/music-metadata shapes,
// and working out author / series / title from tags-less names and folders.
// Pure tests plus one that builds a tiny MP4 by hand; no ffmpeg needed.
// Run: node --test test/audiobook-chapters.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const appRoot = path.resolve(__dirname, '..')
const localRequire = createRequire(path.join(appRoot, 'package.json'))
const chapters = localRequire('./electron/audiobookChapters')
const naming = localRequire('./electron/audiobookNaming')

// --- building a "chpl" box by hand -------------------------------------------------------

function box(type, ...payload) {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
function chplPayload(list, { version = 1 } = {}) {
  const parts = [Buffer.from([version, 0, 0, 0])]
  if (version === 1) parts.push(Buffer.alloc(4))
  parts.push(Buffer.from([list.length]))
  for (const c of list) {
    const t = Buffer.alloc(8)
    t.writeBigUInt64BE(BigInt(Math.round(c.start * 1e7)))
    const title = Buffer.from(c.title, 'utf8')
    parts.push(t, Buffer.from([title.length]), title)
  }
  return Buffer.concat(parts)
}

test('parseChplPayload: version 1 and 0 layouts, UTF-8 titles, truncated data', () => {
  const list = [{ start: 0, title: 'Opening Credits' }, { start: 65.5, title: 'Chapitre \u00e9t\u00e9' }, { start: 3725, title: 'The End' }]
  for (const version of [1, 0]) {
    const got = chapters.parseChplPayload(chplPayload(list, { version }))
    assert.deepEqual(got.map((c) => [c.title, c.start]), list.map((c) => [c.title, c.start]), 'version ' + version)
  }
  const whole = chplPayload(list)
  assert.equal(chapters.parseChplPayload(whole.subarray(0, whole.length - 4)).length, 2, 'a cut-off last chapter is dropped, not garbled')
  assert.deepEqual(chapters.parseChplPayload(Buffer.alloc(2)), [])
  assert.deepEqual(chapters.parseChplPayload(null), [])
})

test('readMp4Chapters: finds moov > udta > chpl after a big mdat, 64-bit sizes included', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-ab-chpl-'))
  try {
    const list = [{ start: 0, title: 'One' }, { start: 120, title: 'Two' }, { start: 4000.25, title: 'Three' }]
    const moov = box('moov', box('mvhd', Buffer.alloc(100)), box('udta', box('meta', Buffer.alloc(30)), box('chpl', chplPayload(list))))
    const ftyp = box('ftyp', Buffer.from('M4B \u0000\u0000\u0000\u0000M4B mp42isom', 'latin1'))
    const mdat = box('mdat', Buffer.alloc(200000, 7))
    // A 64-bit-size "free" box in front of the moov: size field 1, then 8 bytes of real size.
    const freeBody = Buffer.alloc(24)
    const bigHead = Buffer.alloc(16)
    bigHead.writeUInt32BE(1, 0)
    bigHead.write('free', 4, 'latin1')
    bigHead.writeBigUInt64BE(BigInt(16 + freeBody.length), 8)
    const file = path.join(dir, 'book.m4b')
    await fsp.writeFile(file, Buffer.concat([ftyp, mdat, bigHead, freeBody, moov]))
    const got = await chapters.readMp4Chapters(file)
    assert.deepEqual(got.map((c) => [c.title, c.start]), [['One', 0], ['Two', 120], ['Three', 4000.25]])

    const none = path.join(dir, 'plain.m4a')
    await fsp.writeFile(none, Buffer.concat([ftyp, mdat, box('moov', box('mvhd', Buffer.alloc(100)))]))
    assert.deepEqual(await chapters.readMp4Chapters(none), [])
    const junk = path.join(dir, 'junk.m4b')
    await fsp.writeFile(junk, Buffer.from('this is not an mp4 file at all'))
    assert.deepEqual(await chapters.readMp4Chapters(junk), [])
    assert.deepEqual(await chapters.readMp4Chapters(path.join(dir, 'missing.m4b')), [])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('normalizeChapters: sorted, ends filled in, clamped to the book, duplicates merged, titles cleaned', () => {
  const out = chapters.normalizeChapters([
    { title: 'Third', start: 300 },
    { title: '  First\u0007\n', start: 0 },
    { title: '', start: 100 },
    { title: 'dup', start: 100.1 },
    { title: 'Past the end', start: 999 },
    { title: 'Negative', start: -5 },
    { title: 'NaN', start: 'x' },
    null
  ], 400)
  assert.deepEqual(out, [
    { title: 'First', start: 0, end: 100 },
    { title: 'Chapter 2', start: 100, end: 300 },
    { title: 'Third', start: 300, end: 400 }
  ])
  assert.deepEqual(chapters.normalizeChapters('nope', 10), [])
  const many = Array.from({ length: 6000 }, (_, i) => ({ title: 'c', start: i }))
  assert.equal(chapters.normalizeChapters(many, 7000).length, chapters.MAX_CHAPTERS)
})

test('fromFfprobe and fromMusicMetadata: the other places chapters come from', () => {
  assert.deepEqual(chapters.fromFfprobe({ chapters: [
    { start_time: '0.000000', tags: { title: 'Intro' } },
    { start: 90000, time_base: '1/1000', tags: { TITLE: 'Part 2' } },
    { start_time: 'N/A' }
  ] }), [{ title: 'Intro', start: 0 }, { title: 'Part 2', start: 90 }])
  assert.deepEqual(chapters.fromFfprobe({}), [])

  const track = chapters.fromMusicMetadata({ format: { chapters: [{ title: 'A', start: 0, timeScale: 1000 }, { title: 'B', start: 45000, timeScale: 1000 }] } })
  assert.deepEqual(track, [{ title: 'A', start: 0 }, { title: 'B', start: 45 }])
  const id3 = chapters.fromMusicMetadata({
    format: {},
    native: {
      'ID3v2.4': [
        { id: 'TIT2', value: 'A book' },
        { id: 'CHAP', value: { label: 'ch1', info: { startTime: 0, endTime: 5000 }, frames: new Map([['TIT2', 'Opening']]) } },
        { id: 'CHAP', value: { label: 'ch2', info: { startTime: 5000, endTime: 9000 }, frames: new Map() } }
      ]
    }
  })
  assert.deepEqual(id3, [{ title: 'Opening', start: 0 }, { title: 'ch2', start: 5 }])
})

test('parseCue: FILE, TRACK, INDEX 01 frames, quotes, byte-order marks; tracks without INDEX 01 are skipped', () => {
  const cue = chapters.parseCue([
    '\uFEFFPERFORMER "An Author"',
    'TITLE "The Book"',
    'FILE "book.m4b" WAVE',
    '  TRACK 01 AUDIO',
    '    TITLE "Chapter One"',
    '    INDEX 01 00:00:00',
    '  TRACK 02 AUDIO',
    '    TITLE "Chapter Two"',
    '    INDEX 00 10:59:60',
    '    INDEX 01 11:00:37',
    '  TRACK 03 AUDIO',
    '    TITLE "No index"',
    'REM COMMENT ignored'
  ].join('\r\n'))
  assert.equal(cue.title, 'The Book')
  assert.equal(cue.performer, 'An Author')
  assert.deepEqual(cue.tracks.map((t) => [t.file, t.title, Math.round(t.start * 100) / 100]), [['book.m4b', 'Chapter One', 0], ['book.m4b', 'Chapter Two', 660.49]])
})

test('chaptersFromCue: one file, renamed file, several files, unknown files', () => {
  const single = chapters.parseCue('FILE "old-name.wav" WAVE\nTRACK 1 AUDIO\nTITLE "A"\nINDEX 01 00:00:00\nTRACK 2 AUDIO\nTITLE "B"\nINDEX 01 05:00:00')
  assert.deepEqual(chapters.chaptersFromCue(single, [{ path: '/x/book.m4b', start: 0, duration: 900 }]), [{ title: 'A', start: 0 }, { title: 'B', start: 300 }], 'a one-file cue applies to the one part whatever it is called')
  const multi = chapters.parseCue('FILE "01.mp3" MP3\nTRACK 1 AUDIO\nTITLE "One"\nINDEX 01 00:00:00\nFILE "02.mp3" MP3\nTRACK 2 AUDIO\nTITLE "Two"\nINDEX 01 00:30:00\nFILE "gone.mp3" MP3\nTRACK 3 AUDIO\nTITLE "Lost"\nINDEX 01 00:00:00')
  const parts = [{ path: '/b/01.mp3', start: 0, duration: 600 }, { path: 'C:\\b\\02.MP3', start: 600, duration: 600 }]
  assert.deepEqual(chapters.chaptersFromCue(multi, parts), [{ title: 'One', start: 0 }, { title: 'Two', start: 630 }], 'offsets add the part start; unmatched files are skipped')
  assert.deepEqual(chapters.chaptersFromCue(null, parts), [])
  assert.deepEqual(chapters.chaptersFromParts([{ title: 'a', start: 0 }, { start: 5 }]), [{ title: 'a', start: 0 }, { title: 'Part 2', start: 5 }])
})

test('readCueFile: UTF-16 and Latin-1 cue sheets, size cap', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'beebo-ab-cue-'))
  try {
    const text = 'FILE "b.m4b" WAVE\nTRACK 1 AUDIO\nTITLE "Caf\u00e9"\nINDEX 01 01:00:00\n'
    const u16 = path.join(dir, 'u16.cue')
    await fsp.writeFile(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
    const l1 = path.join(dir, 'l1.cue')
    await fsp.writeFile(l1, Buffer.from(text, 'latin1'))
    for (const f of [u16, l1]) {
      const cue = await chapters.readCueFile(f)
      assert.equal(cue.tracks[0].title, 'Caf\u00e9')
      assert.equal(cue.tracks[0].start, 60)
    }
    const big = path.join(dir, 'big.cue')
    await fsp.writeFile(big, Buffer.alloc(3 * 1024 * 1024, 65))
    assert.equal(await chapters.readCueFile(big), null)
    assert.equal(await chapters.readCueFile(path.join(dir, 'missing.cue')), null)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

// --- names -------------------------------------------------------------------------------

test('series from strings and titles', () => {
  assert.deepEqual(naming.parseSeriesString('The Stormlight Archive #1'), { name: 'The Stormlight Archive', index: 1 })
  assert.deepEqual(naming.parseSeriesString('Discworld, Book 5'), { name: 'Discworld', index: 5 })
  assert.deepEqual(naming.parseSeriesString('Vol. 2.5'.replace('Vol. 2.5', 'Expanse Vol. 2.5')), { name: 'Expanse', index: 2.5 })
  assert.deepEqual(naming.parseSeriesString('Catch 22'), { name: 'Catch 22', index: null }, 'a bare number is part of the name')
  assert.equal(naming.parseSeriesString('  '), null)
  assert.deepEqual(naming.seriesFromTitle('The Way of Kings (The Stormlight Archive #1)'), { title: 'The Way of Kings', series: 'The Stormlight Archive', index: 1 })
  assert.deepEqual(naming.seriesFromTitle('Mistborn, Book 1: The Final Empire'), { title: 'The Final Empire', series: 'Mistborn', index: 1 })
  assert.equal(naming.seriesFromTitle('Dune'), null)
  assert.equal(naming.seriesFromTitle('Book 1'), null)
})

test('leading numbers and clean names', () => {
  assert.deepEqual(naming.leadingIndex('03 - The Title'), { index: 3, rest: 'The Title' })
  assert.deepEqual(naming.leadingIndex('Book 2 - X'), { index: 2, rest: 'X' })
  assert.deepEqual(naming.leadingIndex('#3. Y'), { index: 3, rest: 'Y' })
  assert.equal(naming.leadingIndex('1984 - Something'), null, 'a year is not a series number')
  assert.equal(naming.cleanName('01 - Chapter_One.mp3'), 'Chapter One')
  assert.equal(naming.cleanName('Track 05.mp3'), 'Track 05', 'never empty')
  assert.equal(naming.cleanName('Part 3 - Deep'), 'Deep')
})

test('inferFromPath: Author/Series/Title, Author/Title, single files, matching folder names', () => {
  assert.deepEqual(naming.inferFromPath(['Brandon Sanderson', 'Mistborn', '01 - The Final Empire']), { author: 'Brandon Sanderson', series: 'Mistborn', title: 'The Final Empire', index: 1 })
  assert.deepEqual(naming.inferFromPath(['Author', 'Series'], '02 - Book Two'), { author: 'Author', series: 'Series', title: 'Book Two', index: 2 })
  assert.deepEqual(naming.inferFromPath(['Author', 'Title'], 'Title'), { author: 'Author', series: '', title: 'Title', index: null }, 'a folder named like its file is the book folder')
  assert.deepEqual(naming.inferFromPath([], 'Only Title'), { author: '', series: '', title: 'Only Title', index: null })
  assert.deepEqual(naming.inferFromPath(['Some Book']), { author: '', series: '', title: 'Some Book', index: null })
})

test('displayAuthor swaps only a single "Last, First"', () => {
  assert.equal(naming.displayAuthor('Sanderson, Brandon'), 'Brandon Sanderson')
  assert.equal(naming.displayAuthor('Neil Gaiman, Terry Pratchett'), 'Neil Gaiman, Terry Pratchett')
  assert.equal(naming.displayAuthor('Smith, John, Jr.'), 'Smith, John, Jr.')
  assert.equal(naming.displayAuthor('A & B'), 'A & B')
})
