'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const loc = require('../electron/metadataLocale')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'beebo-locale-'))
const MATRIX = { id: 603, title: 'The Matrix', overview: 'English text', release_date: '1999-03-31', certification: 'R' }

const FR_MOVIE = { id: 603, title: 'Matrix', original_title: 'The Matrix', original_language: 'en', overview: 'Un pirate découvre la vérité.', tagline: 'Bienvenue dans le monde réel', release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R', type: 3 }] }, { iso_3166_1: 'FR', release_dates: [{ certification: '12', type: 3 }] }] } }

test('normalizeLanguage accepts the spellings people and operating systems use', () => {
  assert.equal(loc.normalizeLanguage('fr'), 'fr-FR')
  assert.equal(loc.normalizeLanguage('fr_ca'), 'fr-CA')
  assert.equal(loc.normalizeLanguage('EN-us'), 'en-US')
  assert.equal(loc.normalizeLanguage('pt'), 'pt-BR')
  assert.equal(loc.normalizeLanguage('de-AT'), 'de-DE', 'a region TMDB has no translation for falls back to the language\'s main one')
  assert.equal(loc.normalizeLanguage('en_US.UTF-8'), 'en-US')
  for (const bad of ['', 'x', 'klingon', '../../etc', 'fr-FR; DROP', null, 5, 'xx-YY']) assert.equal(loc.normalizeLanguage(bad), null, String(bad))
})

test('resolve: follows the computer by default, falls back to English (US) and region US', () => {
  assert.deepEqual(loc.resolve('', '', 'fr-CA'), { language: 'fr-CA', region: 'CA' })
  assert.deepEqual(loc.resolve('auto', 'auto', 'de'), { language: 'de-DE', region: 'DE' })
  assert.deepEqual(loc.resolve('', '', 'xx-ZZ'), { language: 'en-US', region: 'US' })
  assert.deepEqual(loc.resolve('', '', undefined), { language: 'en-US', region: 'US' })
  assert.deepEqual(loc.resolve('fr-FR', 'ca', 'en-US'), { language: 'fr-FR', region: 'CA' }, 'an explicit region wins')
  assert.deepEqual(loc.resolve('junk', 'junk', 'en-GB'), { language: 'en-US', region: 'GB' })
})

test('isDefault / tagOf: English (US) needs no layer and no file', () => {
  assert.equal(loc.isDefault({ language: 'en-US', region: 'US' }), true)
  assert.equal(loc.isDefault({ language: 'en-US', region: 'CA' }), false, 'a different age-rating region is a different layer')
  assert.equal(loc.tagOf({ language: 'en-US', region: 'US' }), '')
  assert.equal(loc.tagOf({ language: 'fr-FR', region: 'FR' }), 'fr-FR_FR')
})

test('setting validators accept only known values', () => {
  assert.equal(loc.validLanguageSetting('fr-FR'), true)
  assert.equal(loc.validLanguageSetting('auto'), true)
  assert.equal(loc.validLanguageSetting('fr-XX'), false)
  assert.equal(loc.validLanguageSetting('../x'), false)
  assert.equal(loc.validRegionSetting('ca'), true)
  assert.equal(loc.validRegionSetting('CAN'), false)
})

test('pickCertification: the region\'s rating, else the US one, else nothing', () => {
  const results = FR_MOVIE.release_dates.results
  assert.equal(loc.pickCertification(results, 'FR', { movie: true }), '12')
  assert.equal(loc.pickCertification(results, 'CA', { movie: true }), 'R')
  assert.equal(loc.pickCertification([], 'CA', { movie: true }), null)
  const tv = [{ iso_3166_1: 'US', rating: 'TV-MA' }, { iso_3166_1: 'DE', rating: '16' }]
  assert.equal(loc.pickCertification(tv, 'DE', { movie: false }), '16')
  assert.equal(loc.pickCertification(tv, 'JP', { movie: false }), 'TV-MA')
})

test('toLayerRecord: keeps translations, drops empty ones and titles that are only the original language', () => {
  const rec = loc.toLayerRecord('movie', FR_MOVIE, { language: 'fr-FR', region: 'FR' }, 1)
  assert.deepEqual(rec, { at: 1, title: 'Matrix', overview: 'Un pirate découvre la vérité.', tagline: 'Bienvenue dans le monde réel', certification: '12' })
  const jp = loc.toLayerRecord('movie', { title: '千と千尋の神隠し', original_title: '千と千尋の神隠し', original_language: 'ja', overview: '', release_dates: { results: [] } }, { language: 'fr-FR', region: 'FR' }, 1)
  assert.deepEqual(jp, { at: 1 }, 'no French translation exists: nothing to overlay, English stays')
  const same = loc.toLayerRecord('movie', { title: 'Amélie', original_title: 'Amélie', original_language: 'fr', overview: 'x' }, { language: 'fr-FR', region: 'FR' }, 1)
  assert.equal(same.title, 'Amélie', 'a film whose original language IS the chosen language keeps its title')
  assert.deepEqual(loc.toLayerRecord('movie', null, { language: 'fr-FR', region: 'FR' }, 5), { at: 5, none: true })
})

function fakeApi(calls, answers) {
  return (key) => ({
    get: async (p, params) => {
      calls.push({ key, path: p, params })
      const a = answers[p]
      return a === undefined ? { ok: false, status: 404 } : a === 'down' ? { ok: false, status: 503 } : { ok: true, data: a }
    }
  })
}

test('localizer: default language never touches the network or the disk', async () => {
  const dir = tmp()
  const calls = []
  const l = loc.createLocalizer({ getApiKey: () => 'k', getLocale: () => ({ language: 'en-US', region: 'US' }), createApi: fakeApi(calls, {}) })
  assert.equal(l.apply('movie', MATRIX, dir), MATRIX)
  await l.whenIdle()
  assert.equal(calls.length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'localized')), false)
})

test('localizer: the first read is English and queues a fetch; the next read is translated; requests carry only id, language and region', async () => {
  const dir = tmp()
  const calls = []
  const l = loc.createLocalizer({ getApiKey: () => 'secret-key', getLocale: () => ({ language: 'fr-FR', region: 'FR' }), createApi: fakeApi(calls, { '/movie/603': FR_MOVIE }) })
  assert.equal(l.apply('movie', MATRIX, dir), MATRIX, 'nothing cached yet: English, no waiting')
  await l.whenIdle()
  const out = l.apply('movie', MATRIX, dir)
  assert.equal(out.title, 'Matrix')
  assert.equal(out.overview, 'Un pirate découvre la vérité.')
  assert.equal(out.tagline, 'Bienvenue dans le monde réel')
  assert.equal(out.certification, '12')
  assert.equal(out.localized, 'fr-FR')
  assert.equal(out.release_date, MATRIX.release_date)
  assert.equal(MATRIX.title, 'The Matrix', 'the English cache entry is untouched')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params, { language: 'fr-FR', include_adult: 'false', append_to_response: 'release_dates' })
  assert.equal(calls[0].path, '/movie/603')
  l.apply('movie', MATRIX, dir)
  await l.whenIdle()
  assert.equal(calls.length, 1, 'a cached translation is not fetched again')
})

test('localizer: each language has its own file, so switching back and forth poisons nothing', async () => {
  const dir = tmp()
  let current = { language: 'fr-FR', region: 'FR' }
  const calls = []
  const answers = { '/movie/603': FR_MOVIE }
  const l = loc.createLocalizer({ getApiKey: () => 'k', getLocale: () => current, createApi: (k) => ({ get: async (p, params) => { calls.push(params.language); return { ok: true, data: params.language === 'de-DE' ? { ...FR_MOVIE, title: 'Matrix DE', overview: 'Deutsch', release_dates: { results: [] } } : answers[p] } } }) })
  l.apply('movie', MATRIX, dir); await l.whenIdle()
  current = { language: 'de-DE', region: 'DE' }
  l.apply('movie', MATRIX, dir); await l.whenIdle()
  l.flush()
  assert.deepEqual(fs.readdirSync(path.join(dir, 'localized')).sort(), ['de-DE_DE.json', 'fr-FR_FR.json'])
  assert.equal(l.apply('movie', MATRIX, dir).title, 'Matrix DE')
  assert.equal(l.apply('movie', MATRIX, dir).certification, 'R', 'Germany publishes nothing here: the US rating stays')
  current = { language: 'fr-FR', region: 'FR' }
  assert.equal(l.apply('movie', MATRIX, dir).title, 'Matrix')
  current = { language: 'en-US', region: 'US' }
  assert.equal(l.apply('movie', MATRIX, dir), MATRIX, 'back to English: the untouched English entry')
  assert.deepEqual(calls, ['fr-FR', 'de-DE'])
})

test('localizer: an empty translation keeps the English text, a 404 is remembered for a day, a failing TMDB backs off', async () => {
  const dir = tmp()
  const calls = []
  let clock = 1000
  const l = loc.createLocalizer({ getApiKey: () => 'k', getLocale: () => ({ language: 'fr-FR', region: 'FR' }), now: () => clock, createApi: fakeApi(calls, { '/movie/1': { title: 'X', original_title: 'X', original_language: 'ja', overview: '' }, '/tv/7': 'down', '/tv/8': 'down', '/tv/9': 'down', '/tv/10': 'down', '/tv/11': 'down', '/tv/12': 'down' }) })
  l.apply('movie', { id: 1, title: 'X', overview: 'English' }, dir)
  await l.whenIdle()
  const kept = l.apply('movie', { id: 1, title: 'X', overview: 'English' }, dir)
  assert.equal(kept.overview, 'English')
  l.apply('movie', { id: 2, title: 'Gone' }, dir)
  await l.whenIdle()
  const before = calls.length
  l.apply('movie', { id: 2, title: 'Gone' }, dir)
  await l.whenIdle()
  assert.equal(calls.length, before, 'a missing film is not asked for again straight away')
  clock += 2 * 24 * 3600 * 1000
  l.apply('movie', { id: 2, title: 'Gone' }, dir)
  await l.whenIdle()
  assert.equal(calls.length, before + 1, 'but is retried after a day')
  for (let i = 0; i < 6; i++) { l.apply('tv', { id: 7 + i, name: 'Show' }, dir); await l.whenIdle() }
  const failed = calls.filter((c) => c.path.startsWith('/tv/')).length
  assert.ok(failed <= 5, 'stops after repeated failures instead of hammering TMDB: ' + failed)
})

test('localizer: no API key, no request; an entry without a TMDB id is left alone; a damaged layer file is survived', async () => {
  const dir = tmp()
  const calls = []
  const l = loc.createLocalizer({ getApiKey: () => '', getLocale: () => ({ language: 'fr-FR', region: 'FR' }), createApi: fakeApi(calls, {}) })
  assert.equal(l.apply('movie', MATRIX, dir), MATRIX)
  await l.whenIdle()
  assert.equal(calls.length, 0)
  assert.deepEqual(l.apply('movie', { title: 'No id' }, dir), { title: 'No id' })
  assert.equal(l.apply('movie', null, dir), null)
  fs.mkdirSync(path.join(dir, 'localized'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'localized', 'fr-FR_FR.json'), '{ broken')
  const l2 = loc.createLocalizer({ getApiKey: () => 'k', getLocale: () => ({ language: 'fr-FR', region: 'FR' }), createApi: fakeApi(calls, { '/movie/603': FR_MOVIE }) })
  l2.apply('movie', MATRIX, dir)
  await l2.whenIdle()
  assert.equal(l2.apply('movie', MATRIX, dir).title, 'Matrix')
})

test('localizeAll fetches every listed title and reports progress', async () => {
  const dir = tmp()
  const calls = []
  const l = loc.createLocalizer({ getApiKey: () => 'k', getLocale: () => ({ language: 'fr-FR', region: 'FR' }), createApi: fakeApi(calls, { '/movie/603': FR_MOVIE, '/tv/1396': { name: 'Breaking Bad FR', original_name: 'Breaking Bad', original_language: 'en', overview: 'Un prof', content_ratings: { results: [{ iso_3166_1: 'FR', rating: '16' }] } } }) })
  const seen = []
  const result = await l.localizeAll(dir, [{ kind: 'movie', id: 603 }, { kind: 'tv', id: 1396 }, { kind: 'bogus', id: 1 }, { kind: 'movie', id: -4 }], (done, total) => seen.push([done, total]))
  assert.equal(result.total, 2)
  assert.equal(result.remaining, 0)
  assert.equal(l.apply('tv', { id: 1396, name: 'Breaking Bad' }, dir).name, 'Breaking Bad FR')
  assert.equal(l.apply('tv', { id: 1396, name: 'Breaking Bad' }, dir).certification, '16')
  assert.ok(seen.length >= 1)
})
