const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let form
test.before(async () => {
  form = await import(pathToFileURL(path.resolve(__dirname, '../src/lib/metadataForm.js')).href)
})

const DATA = {
  kind: 'movie',
  auto: { title: 'The Matrix', sortTitle: '', year: '1999', overview: 'TMDB text', tagline: 'Free your mind', genres: [28, 878], certification: 'R', rating: 8.2, collection: '' },
  edited: { fields: {}, poster: null, backdrop: null }
}

test('an untouched form produces an empty patch and is not dirty', () => {
  const f = form.initialForm(DATA)
  assert.deepEqual(form.buildPatch(f, DATA), { fields: {}, clear: [] })
  assert.equal(form.isDirty(f, DATA), false)
})

test('a changed field is sent locked by default; unlocking sends the fallback flag; equal values are not sent', () => {
  const f = form.initialForm(DATA)
  f.fields.title.value = '  My Matrix  '
  f.fields.overview.value = 'TMDB text'
  f.fields.tagline.value = 'Mine'
  f.fields.tagline.locked = false
  f.fields.genres.value = [878, 28]
  const p = form.buildPatch(f, DATA)
  assert.deepEqual(p.fields, { title: { value: 'My Matrix', locked: true }, tagline: { value: 'Mine', locked: false } })
  assert.equal(form.isDirty(f, DATA), true)
})

test('genre changes, emptied optional fields and blanking a description are sent', () => {
  const f = form.initialForm(DATA)
  f.fields.genres.value = [35]
  f.fields.overview.value = ''
  f.fields.certification.value = ''
  const p = form.buildPatch(f, DATA)
  assert.deepEqual(p.fields.genres, { value: [35], locked: true })
  assert.deepEqual(p.fields.overview, { value: '', locked: true })
  assert.deepEqual(p.fields.certification, { value: '', locked: true })
})

test('stored edits start filled in; leaving them changes nothing; "use automatic" clears just that field', () => {
  const data = { ...DATA, edited: { fields: { title: { value: 'Mine', locked: true }, overview: { value: 'Also mine', locked: false } }, poster: { file: 'a'.repeat(32) + '.jpg', source: 'upload' }, backdrop: null } }
  const f = form.initialForm(data)
  assert.equal(f.fields.title.value, 'Mine')
  assert.equal(f.fields.overview.locked, false)
  assert.equal(f.hadPoster, true)
  assert.deepEqual(form.buildPatch(f, data), { fields: {}, clear: [] })
  f.fields.title.useAuto = true
  assert.deepEqual(form.buildPatch(f, data), { fields: {}, clear: ['title'] })
  f.fields.title.useAuto = false
  f.fields.overview.locked = true
  assert.deepEqual(form.buildPatch(f, data).fields.overview, { value: 'Also mine', locked: true })
})

test('rating: empty clears an edited rating, a number is sent as typed', () => {
  const data = { ...DATA, edited: { fields: { rating: { value: 9, locked: true } }, poster: null, backdrop: null } }
  const f = form.initialForm(data)
  f.fields.rating.value = ''
  assert.deepEqual(form.buildPatch(f, data).clear, ['rating'])
  f.fields.rating.value = '7.5'
  assert.deepEqual(form.buildPatch(f, data).fields.rating, { value: '7.5', locked: true })
})

test('artwork choices: set sends the prepared picture, auto sends null, none sends nothing', () => {
  const f = form.initialForm(DATA)
  f.poster = { change: 'set', art: { file: 'b'.repeat(32) + '.jpg', source: 'tmdb', forTmdbId: 603, url: 'http://x' } }
  f.backdrop = { change: 'auto', art: null }
  const p = form.buildPatch(f, DATA)
  assert.deepEqual(p.poster, { file: 'b'.repeat(32) + '.jpg', source: 'tmdb', forTmdbId: 603 })
  assert.equal(p.backdrop, null)
  assert.equal('poster' in form.buildPatch(form.initialForm(DATA), DATA), false)
})

test('shows have no tagline or collection field', () => {
  assert.deepEqual(form.fieldsFor('show').map((f) => f.name), ['title', 'sortTitle', 'year', 'overview', 'genres', 'certification', 'rating'])
  assert.ok(form.fieldsFor('movie').some((f) => f.name === 'collection'))
})

test('artErrorText: plain wording, nothing for a cancelled dialog', () => {
  assert.equal(form.artErrorText({ ok: true }), '')
  assert.equal(form.artErrorText({ ok: false, error: 'canceled' }), '')
  assert.match(form.artErrorText({ ok: false, error: 'not_matched' }), /no TMDB match/)
  assert.equal(form.artErrorText({ ok: false, error: 'bad_image', message: 'That image is larger than 12 MB.' }), 'That image is larger than 12 MB.')
  assert.ok(form.artErrorText({ ok: false, error: 'whatever' }))
})
