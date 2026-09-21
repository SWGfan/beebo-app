'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const memo = require('../electron/parseMemo')
const titleParse = require('../electron/titleParse')
const tmdbCache = require('../electron/tmdbCache')

const NAMES = [
  'Alien (1979).mp4', 'The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv', 'Some Film [imdbid-tt0111161].mp4', 'Independence Day (1996) mkv.mkv',
  'Show S01E02 Title.mkv', 'weird__name (converted).mp4', '', 'Heat (1995) (converted).mp4', 'Ünïcode Fïlm (2001).avi'
]

test('a memoized parse answers exactly what the parser does, every time, as its own copy', () => {
  const m = memo.createParseMemo(titleParse.parseMovieTitle)
  for (let round = 0; round < 3; round++) {
    for (const n of NAMES) assert.deepEqual(m(n), titleParse.parseMovieTitle(n), n)
  }
  const a = m('Alien (1979).mp4')
  a.title = 'scribbled'
  if (a.episode && typeof a.episode === 'object') a.episode.season = 99
  assert.deepEqual(m('Alien (1979).mp4'), titleParse.parseMovieTitle('Alien (1979).mp4'))
  assert.notEqual(m('Alien (1979).mp4'), m('Alien (1979).mp4'))
})

test('non-strings pass straight through, and the memo forgets when it is full', () => {
  let calls = 0
  const m = memo.createParseMemo((x) => { calls++; return { v: x } }, 3)
  assert.deepEqual(m(undefined), { v: undefined })
  m('a'); m('a'); assert.equal(calls, 2)
  m('b'); m('c'); m('d') // 4th distinct key clears
  m('a')
  assert.ok(calls >= 6)
})

test('keyed memo computes once per key', () => {
  let calls = 0
  const k = memo.createKeyedMemo(10)
  const a = k('x', () => { calls++; return { n: 1 } })
  assert.equal(k('x', () => { calls++; return { n: 2 } }), a)
  assert.equal(calls, 1)
})

test('stat memo: the same answer for a minute, then a fresh stat; failures are remembered and thrown again', () => {
  memo.statMemo.clear()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-statmemo-'))
  const f = path.join(dir, 'a.mp4')
  fs.writeFileSync(f, 'abc')
  let stats = 0
  const counting = (p) => { stats++; return fs.statSync(p) }
  const t0 = 1000000
  assert.equal(memo.statMemo(f, t0, counting).size, 3)
  fs.writeFileSync(f, 'abcdef')
  assert.equal(memo.statMemo(f, t0 + 1000, counting).size, 3, 'inside the window: the remembered answer')
  assert.equal(stats, 1)
  assert.equal(memo.statMemo(f, t0 + memo.STAT_TTL_MS + 1, counting).size, 6, 'after the window: looked at again')
  const gone = path.join(dir, 'gone.mp4')
  assert.throws(() => memo.statMemo(gone, t0, counting), /ENOENT/)
  const before = stats
  assert.throws(() => memo.statMemo(gone, t0 + 5, counting), /ENOENT/)
  assert.equal(stats, before, 'the failure is remembered too')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createJoiner gives exactly what path.join gives (win32 and posix flavours, odd folders and odd relative paths)', () => {
  for (const flavour of [path.win32, path.posix]) {
    const join = memo.createJoiner(flavour)
    const s = flavour.sep
    const dirs = flavour === path.win32 ? ['D:\\TV', 'D:\\TV\\', 'D:/TV', 'd:\\tv shows\\extra', '\\\\nas\\media\\TV', '.', '', 'TV', 'D:\\a\\..\\TV'] : ['/mnt/tv', '/mnt/tv/', '/mnt//tv', '.', '', 'tv', '/mnt/a/../tv']
    const rels = [`Show A${s}Season 1${s}Show A S01E01.mkv`, 'Flat Show S02E05.webm', `Show B${s}x.mp4`, '', '.hidden.mp4', `..${s}escape.mp4`, `a${s}..${s}b.mp4`, `a${s}${s}b.mp4`, `${s}abs.mp4`, 'C:x.mp4', 'a/b.mp4', 'a\\b.mp4', 'name with spaces (2001).mp4']
    for (const d of dirs) for (const r of rels) assert.equal(join(d, r), flavour.join(d, r), `${d} + ${r}`)
  }
})

test('createAddedLookup finds what resolving every path would have found', () => {
  for (const flavour of [path.win32, path.posix]) {
    const root = flavour === path.win32 ? 'D:\\TV' : '/mnt/tv'
    const s = flavour.sep
    const added = new Map([[flavour.resolve(root, 'Show A', 'Season 1', 'Show A S01E02.mkv'), 111], [flavour.resolve(root, 'Flat S01E01.mp4'), 222], [flavour.resolve(root + '2', 'Other', 'x.mp4'), 333]])
    const lookup = memo.createAddedLookup(added, flavour)
    const eps = [[root, `Show A${s}Season 1${s}Show A S01E02.mkv`], [root, `Show A${s}Season 1${s}Show A S01E03.mkv`], [root, 'Flat S01E01.mp4'], [root + s, 'Flat S01E01.mp4'], [root + '2', `Other${s}x.mp4`], [root, `Other${s}x.mp4`]]
    for (const [d, r] of eps) assert.equal(lookup(d, r), added.get(flavour.resolve(flavour.join(d, r))) || 0, `${d} + ${r}`)
    assert.equal(memo.createAddedLookup(new Map(), flavour)(root, 'a.mp4'), 0)
  }
})

test('hasEntries is true only for an object with an own key', () => {
  assert.equal(memo.hasEntries({}), false)
  assert.equal(memo.hasEntries(null), false)
  assert.equal(memo.hasEntries(undefined), false)
  assert.equal(memo.hasEntries({ a: 1 }), true)
  assert.equal(memo.hasEntries(Object.create({ inherited: 1 })), false)
})

test('the image index answers TV posters exactly like localTvPosterPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-tvposter-'))
  fs.mkdirSync(path.join(dir, 'posters-tv'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'posters-tv', '123.jpg'), 'x')
  const idx = tmdbCache.localImageIndex(dir)
  for (const id of [123, 124, '123', 0, undefined]) assert.equal(idx.hasTvPoster(id), !!tmdbCache.localTvPosterPath(dir, id), String(id))
  assert.equal(tmdbCache.localImageIndex(null).hasTvPoster(123), false)
  fs.rmSync(dir, { recursive: true, force: true })
})
