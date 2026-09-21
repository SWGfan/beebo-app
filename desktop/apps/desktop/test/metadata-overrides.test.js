'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const mo = require('../electron/metadataOverrides')
const tmdbCache = require('../electron/tmdbCache')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-overrides-'))
const MATRIX = { id: 603, title: 'The Matrix', overview: 'A hacker learns the truth.', release_date: '1999-03-31', genre_ids: [28, 878], vote_average: 8.2, poster_path: '/abc.jpg', backdrop_path: '/bd.jpg', certification: 'R' }

test('cleanText removes control characters and direction overrides, keeps ordinary text and emoji', () => {
  assert.equal(mo.cleanText('Hello\u0000 \u202Eworld\u0007', 100), 'Hello world')
  assert.equal(mo.cleanText('a\u2028b\u2029c', 100), 'a b c')
  assert.equal(mo.cleanText('Amélie 🎬 <b>x</b> & "q"', 100), 'Amélie 🎬 <b>x</b> & "q"')
  assert.equal(mo.cleanText('e\u0301', 100), '\u00e9', 'normalised to NFC')
  assert.equal(mo.cleanText({ toString() { return 'no' } }, 100), '', 'only strings and numbers are text')
  assert.equal(mo.cleanText(null, 100), '')
})

test('cleanText caps by characters without cutting an emoji in half, and keeps paragraphs in multiline mode', () => {
  const out = mo.cleanText('🎬'.repeat(50), 10)
  assert.equal(Array.from(out).length, 10)
  assert.equal(JSON.parse(JSON.stringify(out)), out)
  assert.equal(mo.cleanText('one\r\n\r\n\r\n\r\ntwo   words\n', 100, { multiline: true }), 'one\n\ntwo words')
  assert.equal(mo.cleanText('one\ntwo', 100), 'one two')
  assert.doesNotMatch(mo.cleanText('x\uD800y', 100), /[\uD800-\uDFFF]/, 'a lone surrogate is dropped')
})

test('sanitiseFields validates each field and reports the bad ones by name', () => {
  const ok = mo.sanitiseFields({ title: 'My Cut', year: '1999', genres: ['Sci-Fi', 'action', 'Klingon Opera'], certification: 'PG-13', rating: '7.46' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.fields.title, { value: 'My Cut', locked: true })
  assert.equal(ok.fields.year.value, '1999')
  assert.deepEqual(ok.fields.genres.value, [878, 28])
  assert.equal(ok.fields.rating.value, 7.5)

  const bad = mo.sanitiseFields({ title: '   ', year: 'nineteen', certification: '<script>', rating: 11, genres: ['Klingon Opera'] })
  assert.equal(bad.ok, false)
  assert.deepEqual(Object.keys(bad.errors).sort(), ['certification', 'genres', 'rating', 'title', 'year'])
  assert.deepEqual(bad.fields, {})

  assert.equal(mo.sanitiseFields({ year: '1500' }).ok, false)
  assert.equal(mo.sanitiseFields({ year: '' }).fields.year.value, '', 'an empty year means "no year"')
})

test('sanitiseFields ignores unknown fields and prototype tricks and honours lock flags', () => {
  const r = mo.sanitiseFields(JSON.parse('{"__proto__":{"x":1},"constructor":"x","poster_path":"/evil","title":{"value":"T","locked":false},"overview":"O"}'))
  assert.deepEqual(Object.keys(r.fields).sort(), ['overview', 'title'])
  assert.equal(r.fields.title.locked, false)
  assert.equal(r.fields.overview.locked, true)
  assert.equal({}.x, undefined)
})

test('limits are enforced', () => {
  const r = mo.sanitiseFields({ title: 'x'.repeat(5000), overview: 'y'.repeat(50000), tagline: 'z'.repeat(2000), collection: 'c'.repeat(1000), genres: new Array(100).fill(28) })
  assert.equal(Array.from(r.fields.title.value).length, mo.LIMITS.title)
  assert.equal(Array.from(r.fields.overview.value).length, mo.LIMITS.overview)
  assert.equal(Array.from(r.fields.tagline.value).length, mo.LIMITS.tagline)
  assert.equal(Array.from(r.fields.collection.value).length, mo.LIMITS.collection)
  assert.deepEqual(r.fields.genres.value, [28])
})

test('keys: movies by file name, shows by lower-case name in either spelling, nothing dangerous', () => {
  assert.equal(mo.movieKey('The Matrix (1999).mkv'), 'The Matrix (1999).mkv')
  for (const bad of ['', '__proto__', 'constructor', 'a\u0000b', 'x'.repeat(501), null, 42]) assert.equal(mo.movieKey(bad), null, String(bad))
  const b64 = Buffer.from('breaking bad', 'utf8').toString('base64url')
  assert.equal(mo.showKey(b64), 'breaking bad')
  assert.equal(mo.showKey('Breaking Bad'), 'breaking bad')
  assert.equal(mo.showKey('friends'), 'friends', 'a plain name that merely decodes as base64 is left alone')
  assert.equal(mo.showKey('__proto__'), null)
})

test('applyRecord: locked fields win, unlocked fields only fill gaps, year keeps the month and day', () => {
  const rec = { fields: mo.sanitiseFields({ title: 'The Matrix: Redux', year: 2003, overview: { value: 'Mine', locked: false }, tagline: { value: 'Free your mind', locked: false }, genres: ['Drama'], certification: 'PG-13', rating: 9, collection: 'My Matrix Set', sortTitle: 'Matrix 1' }).fields }
  const out = mo.applyRecord('movie', MATRIX, rec)
  assert.equal(out.title, 'The Matrix: Redux')
  assert.equal(out.release_date, '2003-03-31')
  assert.equal(out.overview, 'A hacker learns the truth.', 'unlocked: TMDB has an overview, so it stays')
  assert.equal(out.tagline, 'Free your mind', 'unlocked: TMDB had none, so the fallback shows')
  assert.deepEqual(out.genre_ids, [18])
  assert.equal(out.certification, 'PG-13')
  assert.equal(out.vote_average, 9)
  assert.equal(out.sort_title, 'Matrix 1')
  assert.equal(out.custom_collection.name, 'My Matrix Set')
  assert.ok(out.custom_collection.id >= 900000000)
  assert.equal(out.id, 603)
  assert.deepEqual(out.metadata_edited.sort(), ['certification', 'collection', 'genres', 'rating', 'sortTitle', 'tagline', 'title', 'year'])
  assert.equal(MATRIX.title, 'The Matrix', 'the cached TMDB entry is never mutated')
  assert.equal(mo.applyRecord('movie', MATRIX, null), MATRIX)
  assert.equal(mo.applyRecord('movie', MATRIX, { fields: {}, poster: null, backdrop: null }), MATRIX, 'an empty record changes nothing')
})

test('applyRecord: an unmatched film can still carry typed information; shows use name and first_air_date', () => {
  const rec = { fields: mo.sanitiseFields({ title: 'Home Video', year: 1988 }).fields }
  const out = mo.applyRecord('movie', null, rec)
  assert.equal(out.title, 'Home Video')
  assert.equal(out.release_date, '1988-01-01')
  assert.equal(out.id, null)
  const show = mo.applyRecord('show', { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }, { fields: mo.sanitiseFields({ title: 'BB', year: 2009, certification: 'TV-MA' }).fields })
  assert.equal(show.name, 'BB')
  assert.equal(show.first_air_date, '2009-01-20')
  assert.equal(show.certification, 'TV-MA')
})

test('applyRecord: artwork becomes a custom path, but TMDB artwork chosen for another film is ignored', () => {
  const hex = 'a'.repeat(32)
  const own = mo.applyRecord('movie', MATRIX, { fields: {}, poster: { file: `${hex}.jpg`, source: 'upload', forTmdbId: null }, backdrop: { file: `${'b'.repeat(32)}.jpg`, source: 'tmdb', forTmdbId: 603 } })
  assert.equal(own.poster_path, `/_beebo_${hex}.jpg`)
  assert.equal(mo.customArtUrl(own.poster_path), `/media/artwork/${hex}.jpg`)
  assert.match(own.backdrop_path, /^\/_beebo_b{32}\.jpg$/)
  const rematched = mo.applyRecord('movie', { ...MATRIX, id: 604 }, { fields: {}, poster: { file: `${hex}.jpg`, source: 'upload', forTmdbId: null }, backdrop: { file: `${'b'.repeat(32)}.jpg`, source: 'tmdb', forTmdbId: 603 } })
  assert.equal(rematched.backdrop_path, '/bd.jpg', 'after Fix match the old film\'s backdrop is not shown')
  assert.match(rematched.poster_path, /_beebo_/, 'an image the owner supplied stays')
  assert.equal(mo.customArtUrl('/abc.jpg'), null)
  assert.equal(mo.customArtUrl('/_beebo_../../x.jpg'), null)
})

test('store: edits persist across instances, survive TMDB manifest rewrites, and reset removes the record', () => {
  const dir = tmp()
  const store = mo.forDir(dir)
  const saved = mo.edit(store, 'movie', 'Matrix.mkv', { fields: { title: 'My Matrix', genres: ['Comedy'] }, tmdbId: 603 })
  assert.equal(saved.ok, true)
  assert.ok(fs.existsSync(path.join(dir, mo.FILE_NAME)))

  const paths = tmdbCache.ensureDirs(dir)
  tmdbCache.writeJson(paths.manifestFile, { 'Matrix.mkv': { ...MATRIX, title: 'The Matrix (refreshed)' } })
  tmdbCache.writeJson(paths.manifestFile, { 'Matrix.mkv': { ...MATRIX, title: 'The Matrix (refreshed again)' } })

  const again = mo.createStore({ file: path.join(dir, mo.FILE_NAME) })
  const merged = mo.applyRecord('movie', tmdbCache.getManifest(dir)['Matrix.mkv'], again.get('movie', 'Matrix.mkv'))
  assert.equal(merged.title, 'My Matrix')
  assert.deepEqual(merged.genre_ids, [35])
  assert.equal(merged.overview, MATRIX.overview)

  assert.equal(mo.reset(store, 'movie', 'Matrix.mkv').hadRecord, true)
  assert.equal(store.get('movie', 'Matrix.mkv'), null)
  assert.equal(again.get('movie', 'Matrix.mkv'), null, 'other readers see the reset (mtime gate)')
})

test('edit: a second edit merges, clear puts a field back to automatic, an empty record is removed, invalid input changes nothing', () => {
  const store = mo.forDir(tmp())
  mo.edit(store, 'show', 'Breaking Bad', { fields: { title: 'BB', overview: 'x' } })
  const second = mo.edit(store, 'show', 'breaking bad', { fields: { tagline: 't' }, clear: ['overview'] })
  assert.deepEqual(Object.keys(second.record.fields).sort(), ['tagline', 'title'])
  const bad = mo.edit(store, 'show', 'breaking bad', { fields: { year: 'soon' } })
  assert.equal(bad.ok, false)
  assert.equal(bad.errors.year.length > 0, true)
  assert.equal(store.get('show', 'breaking bad').fields.title.value, 'BB')
  const cleared = mo.edit(store, 'show', 'breaking bad', { clear: ['title', 'tagline'] })
  assert.equal(cleared.removed, true)
  assert.equal(store.has('show', 'breaking bad'), false)
})

test('edit: artwork references must be files Beebo prepared (32 hex characters), never a path', () => {
  const store = mo.forDir(tmp())
  for (const file of ['../../etc/passwd', 'C:\\Windows\\win.ini', 'poster.jpg', `${'a'.repeat(32)}.png`, `${'a'.repeat(31)}.jpg`]) {
    const r = mo.edit(store, 'movie', 'x.mkv', { poster: { file, source: 'upload' } })
    assert.equal(r.ok, false, file)
  }
  const good = mo.edit(store, 'movie', 'x.mkv', { poster: { file: `${'c'.repeat(32)}.jpg`, source: 'sidecar' } })
  assert.equal(good.ok, true)
  assert.deepEqual([...store.artworkInUse()], [`${'c'.repeat(32)}.jpg`])
})

test('a damaged overrides file is set aside, not treated as empty and not overwritten silently', () => {
  const dir = tmp()
  const store = mo.forDir(dir)
  mo.edit(store, 'movie', 'a.mkv', { fields: { title: 'A' } })
  mo.edit(store, 'movie', 'b.mkv', { fields: { title: 'B' } })
  fs.writeFileSync(path.join(dir, mo.FILE_NAME), '{ not json')
  const fresh = mo.createStore({ file: path.join(dir, mo.FILE_NAME) })
  assert.equal(fresh.get('movie', 'a.mkv').fields.title.value, 'A', 'restored from the last good copy')
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith(`${mo.FILE_NAME}.corrupt-`)))
})

test('a hostile file on disk cannot smuggle bad values or prototype keys into the merge', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, mo.FILE_NAME), JSON.stringify({
    v: 1,
    movies: JSON.parse('{"__proto__":{"fields":{"title":{"value":"pwn"}}},"ok.mkv":{"fields":{"title":{"value":"Hi\\u0000\\u202E there","locked":true},"year":{"value":"abc"},"poster_path":{"value":"/x"}},"poster":{"file":"../../x.jpg"}}}'),
    shows: []
  }))
  const store = mo.createStore({ file: path.join(dir, mo.FILE_NAME) })
  const rec = store.get('movie', 'ok.mkv')
  assert.equal(rec.fields.title.value, 'Hi there')
  assert.equal(rec.fields.year, undefined)
  assert.equal(rec.poster, null)
  assert.equal(store.get('movie', '__proto__'), null)
  assert.equal(({}).fields, undefined)
})

test('describe gives the editor plain values and lock flags', () => {
  const store = mo.forDir(tmp())
  mo.edit(store, 'movie', 'a.mkv', { fields: { title: { value: 'A', locked: false } } })
  const d = mo.describe(store.get('movie', 'a.mkv'))
  assert.deepEqual(d.fields.title, { value: 'A', locked: false })
  assert.equal(d.poster, null)
  assert.deepEqual(mo.describe(null), { fields: {}, poster: null, backdrop: null })
})
