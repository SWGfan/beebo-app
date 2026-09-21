// The translation layer (src/lib/i18n.js) and the shipped language files (src/locales/*.json).
// Run: node --test test/i18n.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const src = path.resolve(__dirname, '..', 'src')
const lib = (f) => import(pathToFileURL(path.join(src, 'lib', f)).href)
const localesDir = path.join(src, 'locales')
const loadCatalogs = () => {
  const out = {}
  for (const file of fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'))) out[file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'))
  return out
}
const SHIPPED = ['en', 'es', 'fr', 'de', 'pt-BR', 'it']

test('language tags are cleaned up and matched to the closest shipped language', async () => {
  const { canonicalize, matchLocale, baseLanguage } = await lib('i18n.js')
  assert.equal(canonicalize('pt_br'), 'pt-BR')
  assert.equal(canonicalize('EN-us'), 'en-US')
  assert.equal(canonicalize(''), '')
  assert.equal(canonicalize('not a tag!'), '')
  assert.equal(canonicalize(null), '')
  assert.equal(baseLanguage('fr-CA'), 'fr')
  const have = ['en', 'es', 'fr', 'de', 'pt-BR', 'it']
  assert.equal(matchLocale(['pt-PT'], have), 'pt-BR', 'European Portuguese gets the Brazilian file')
  assert.equal(matchLocale(['es-MX'], have), 'es')
  assert.equal(matchLocale(['fr-CA', 'en'], have), 'fr')
  assert.equal(matchLocale(['pt-br'], have), 'pt-BR', 'case does not matter')
  assert.equal(matchLocale(['ja', 'it-CH'], have), 'it', 'the first wanted language that is shipped wins')
  assert.equal(matchLocale(['ja'], have), null)
  assert.equal(matchLocale([], have), null)
})

test('which language to show: the choice, else the system, else English', async () => {
  const { resolveLocale } = await lib('i18n.js')
  const supported = ['en', 'es', 'fr', 'de', 'pt-BR', 'it']
  assert.deepEqual(resolveLocale({ preference: 'de', systemLanguages: ['fr-FR'], supported }), { code: 'de', source: 'user' })
  assert.deepEqual(resolveLocale({ preference: 'auto', systemLanguages: ['fr-FR', 'en-US'], supported }), { code: 'fr', source: 'system' })
  assert.deepEqual(resolveLocale({ preference: '', systemLanguages: ['pt-PT'], supported }), { code: 'pt-BR', source: 'system' })
  assert.deepEqual(resolveLocale({ preference: 'auto', systemLanguages: ['ja-JP'], supported }), { code: 'en', source: 'fallback' })
  assert.deepEqual(resolveLocale({ preference: 'xx', systemLanguages: ['es'], supported }), { code: 'es', source: 'system' }, 'a language that is no longer shipped falls through to the system one')
  assert.deepEqual(resolveLocale({}), { code: 'en', source: 'fallback' })
})

test('right-to-left languages switch the text direction', async () => {
  const { directionFor, createI18n } = await lib('i18n.js')
  assert.equal(directionFor('ar'), 'rtl')
  assert.equal(directionFor('ar-EG'), 'rtl')
  assert.equal(directionFor('he'), 'rtl')
  assert.equal(directionFor('fa-IR'), 'rtl')
  assert.equal(directionFor('en'), 'ltr')
  assert.equal(directionFor('pt-BR'), 'ltr')
  assert.equal(directionFor(''), 'ltr')
  const i18n = createI18n({ catalogs: { en: { hi: 'Hello' }, ar: { hi: 'مرحبا' } }, locale: 'en' })
  assert.equal(i18n.getSnapshot().dir, 'ltr')
  i18n.setLocale('ar')
  assert.equal(i18n.getSnapshot().dir, 'rtl')
  assert.equal(i18n.getSnapshot().t('hi'), 'مرحبا')
})

test('placeholders are filled, escaped braces stay literal, unknown ones stay visible', async () => {
  const { interpolate } = await lib('i18n.js')
  assert.equal(interpolate('Hello {name}!', { name: 'Ada' }), 'Hello Ada!')
  assert.equal(interpolate('{a} and {a}', { a: 1 }), '1 and 1')
  assert.equal(interpolate('Show {{Name}} S{{season}}', {}), 'Show {Name} S{season}')
  assert.equal(interpolate('Hi {who}', {}), 'Hi {who}', 'a missing value is left as written so the gap is noticed')
  assert.equal(interpolate('Hi {who}', { who: null }), 'Hi {who}')
  assert.equal(interpolate('{n:number} files', { n: 1234.5 }, 'de'), '1.234,5 files')
  assert.equal(interpolate('{n:number} files', { n: 1234.5 }, 'en'), '1,234.5 files')
  assert.equal(interpolate('{p:percent}', { p: 0.42 }, 'en'), '42%')
  assert.equal(interpolate('It costs $5 {x}', { x: '$&' }), 'It costs $5 $&', 'replacement patterns in values are not special')
})

test('plurals follow the language, with exact matches first', async () => {
  const { selectPlural, createI18n } = await lib('i18n.js')
  const movies = { '=0': 'No movies', one: '{count} movie', other: '{count} movies' }
  assert.equal(selectPlural(movies, 0, 'en'), 'No movies')
  assert.equal(selectPlural(movies, 1, 'en'), '{count} movie')
  assert.equal(selectPlural(movies, 2, 'en'), '{count} movies')
  const noZero = { one: '{count} film', other: '{count} films' }
  assert.equal(selectPlural(noZero, 0, 'fr'), '{count} film', 'French counts 0 as singular')
  assert.equal(selectPlural(noZero, 0, 'en'), '{count} films')
  const ru = { one: '{count} фильм', few: '{count} фильма', many: '{count} фильмов', other: '{count} фильма' }
  assert.equal(selectPlural(ru, 1, 'ru'), '{count} фильм')
  assert.equal(selectPlural(ru, 3, 'ru'), '{count} фильма')
  assert.equal(selectPlural(ru, 5, 'ru'), '{count} фильмов')
  assert.equal(selectPlural(ru, 21, 'ru'), '{count} фильм')
  assert.equal(selectPlural({ other: 'x' }, 1, 'en'), 'x', 'other is the fallback form')
  assert.equal(selectPlural(null, 1, 'en'), '')
  // through t(): {count} is formatted for the language
  const i18n = createI18n({ catalogs: { en: { n: { one: '{count} item', other: '{count} items' } }, de: { n: { one: '{count} Element', other: '{count} Elemente' } } }, locale: 'de' })
  assert.equal(i18n.getSnapshot().t('n', { count: 1234 }), '1.234 Elemente')
  assert.equal(i18n.getSnapshot().t('n', { count: 1 }), '1 Element')
})

test('a key missing in the chosen language falls back to English, then to the key, and is reported once', async () => {
  const { createI18n } = await lib('i18n.js')
  const missing = []
  const i18n = createI18n({
    catalogs: { en: { a: 'Alpha', b: 'Beta {x}' }, fr: { a: 'Alfa' } },
    locale: 'fr',
    onMissing: (key, locale) => missing.push([key, locale])
  })
  const { t, tOr, has } = i18n.getSnapshot()
  assert.equal(t('a'), 'Alfa')
  assert.equal(t('b', { x: 1 }), 'Beta 1', 'English fills the gap')
  assert.equal(t('zzz'), 'zzz')
  assert.equal(t('zzz'), 'zzz')
  assert.deepEqual(missing, [['zzz', 'fr']], 'reported once, only when missing everywhere')
  assert.equal(tOr('nav.plugin', 'Plugin {n}', { n: 2 }), 'Plugin 2', 'data-driven text keeps its own words')
  assert.equal(has('a'), true)
  assert.equal(has('nope'), false)
  assert.equal(t('toString'), 'toString', 'object prototype names are not keys')
})

test('changing the language tells subscribers and gives React a new snapshot', async () => {
  const { createI18n } = await lib('i18n.js')
  const i18n = createI18n({ catalogs: { en: { a: 'One' }, es: { a: 'Uno' } }, locale: 'en' })
  const first = i18n.getSnapshot()
  let calls = 0
  const off = i18n.subscribe(() => { calls += 1 })
  i18n.setLocale('es')
  assert.equal(calls, 1)
  assert.notEqual(i18n.getSnapshot(), first)
  assert.equal(i18n.getSnapshot().t('a'), 'Uno')
  assert.equal(first.t('a'), 'One', 'an old snapshot keeps its language')
  i18n.setLocale('es-MX')
  assert.equal(calls, 1, 'the same language again is not a change')
  i18n.setLocale('xx')
  assert.equal(i18n.getSnapshot().locale, 'en', 'an unknown language shows English')
  off()
  i18n.setLocale('es')
  assert.equal(calls, 2, 'no call after unsubscribing')
})

test('numbers, dates, durations, lists and relative times use the language', async () => {
  const m = await lib('i18n.js')
  assert.equal(m.formatNumber(1234567.891, 'en', { maximumFractionDigits: 0 }), '1,234,568')
  assert.equal(m.formatNumber(1234.5, 'de'), '1.234,5')
  assert.equal(m.formatNumber('abc', 'en'), 'abc')
  assert.match(m.formatDate('2026-09-20T12:00:00Z', 'es'), /2026/)
  assert.equal(m.formatDate('not a date', 'en'), '')
  assert.equal(m.formatDuration(148, 'en'), '2 hr 28 min')
  assert.equal(m.formatDuration(45, 'en'), '45 min')
  assert.equal(m.formatDuration(120, 'en'), '2 hr')
  assert.equal(m.formatDuration(0, 'en'), '')
  assert.equal(m.formatDuration('x', 'en'), '')
  assert.match(m.formatDuration(148, 'de'), /Std\.? 28 Min/)
  assert.equal(m.formatList(['A', 'B', 'C'], 'en'), 'A, B, and C')
  assert.equal(m.formatList(['A', 'B', 'C'], 'es'), 'A, B y C')
  assert.deepEqual(m.formatListParts(['A', 'B'], 'fr').filter((p) => p.type === 'element').map((p) => p.value), ['A', 'B'])
  assert.equal(m.formatRelative(-1, 'day', 'en'), 'yesterday')
  assert.match(m.formatRelative(-3, 'day', 'es'), /3 días/)
  // an unusable language tag never throws
  assert.equal(m.formatNumber(5, 'zz-invalid-tag-!!'), '5')
})

test('every shipped language exists, matches English key for key, and keeps placeholders intact', async () => {
  const { summarize } = await lib('i18nCheck.js')
  const catalogs = loadCatalogs()
  for (const code of SHIPPED) assert.ok(catalogs[code], `${code}.json is shipped`)
  const en = catalogs.en
  assert.ok(Object.keys(en).length >= 300, 'the extracted screens are in the English source')
  for (const row of summarize(en, catalogs)) {
    if (!SHIPPED.includes(row.code)) continue
    assert.deepEqual(row.detail.missing, [], `${row.code}: missing keys`)
    assert.deepEqual(row.detail.extra, [], `${row.code}: keys English does not have`)
    assert.deepEqual(row.detail.placeholders, [], `${row.code}: {placeholders} differ from English`)
    assert.deepEqual(row.detail.plurals, [], `${row.code}: plural forms`)
    assert.deepEqual(row.detail.types, [], `${row.code}: plural/plain mismatch`)
    // Brand names and words like "Audio" are legitimately the same; a wholesale copy of English is not.
    assert.ok(row.identical / row.total < 0.12, `${row.code}: ${row.identical} of ${row.total} strings are identical to English`)
  }
})

test('translations keep the inline markup and literal text of the English message', async () => {
  const catalogs = loadCatalogs()
  const tags = (v) => (typeof v === 'string' ? v : Object.values(v).join(' ')).match(/<\/?(?:b|em|code)>/g) || []
  const literals = ['C:\\Beebo', 'beeboentertainment.com', 'Alt+1']
  for (const code of SHIPPED.filter((c) => c !== 'en')) {
    for (const [key, value] of Object.entries(catalogs.en)) {
      const ours = catalogs[code][key]
      assert.deepEqual(tags(ours), tags(value), `${code} ${key}: markup tags`)
      const text = typeof value === 'string' ? value : Object.values(value).join(' ')
      for (const literal of literals) {
        if (text.includes(literal)) assert.ok((typeof ours === 'string' ? ours : Object.values(ours).join(' ')).includes(literal), `${code} ${key}: keeps ${literal}`)
      }
      assert.doesNotMatch(typeof ours === 'string' ? ours : Object.values(ours).join(' '), /<(?!\/?(?:b|em|code)>)[a-z]/i, `${code} ${key}: no other markup`)
    }
  }
})

test('every key the code asks for exists, and every English key is used by the code', async () => {
  const { findKeyUsage, usageReport } = await lib('i18nCheck.js')
  const { en } = loadCatalogs()
  const usages = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'vendor' || /^i18n(Check)?\.js$/.test(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.jsx?$/.test(entry.name)) usages.push(findKeyUsage(fs.readFileSync(full, 'utf8')))
    }
  }
  walk(src)
  const { unused, undefinedKeys } = usageReport(en, usages)
  assert.deepEqual(undefinedKeys, [], 'keys used in code but missing from en.json')
  assert.deepEqual(unused, [], 'keys in en.json that nothing uses (delete them, or the screen lost its translation)')
})

test('the live "found N movies" wording uses each language’s plural rules', async () => {
  const { createI18n } = await lib('i18n.js')
  const { moviesFound, showsFound, suggestionCount } = await lib('firstRunI18n.js')
  const catalogs = loadCatalogs()
  const en = createI18n({ catalogs, locale: 'en' }).getSnapshot().t
  assert.equal(moviesFound(null, en), 'Looking for movies…')
  assert.equal(moviesFound({ movies: { count: 1, done: true } }, en), 'Found 1 movie')
  assert.equal(moviesFound({ movies: { count: 1204, done: true } }, en), 'Found 1,204 movies')
  assert.equal(moviesFound({ movies: { count: 3, done: false } }, en), 'Found 3 movies so far…')
  assert.equal(moviesFound({ movies: { count: 0, done: true } }, en), 'No movies found in this folder yet.')
  assert.equal(moviesFound({ truncated: true, movies: { count: 50, done: true } }, en), 'Found 50 movies (and counting)')
  assert.equal(showsFound({ tv: { count: 20, shows: 1, done: true } }, en), 'Found 20 episodes from 1 show')
  assert.equal(suggestionCount({ videos: 1204, truncated: true }, en), 'at least 1,204 videos')
  const fr = createI18n({ catalogs, locale: 'fr' }).getSnapshot().t
  assert.match(moviesFound({ movies: { count: 1, done: true } }, fr), /\b1 film\b/)
  assert.match(moviesFound({ movies: { count: 0, done: false } }, fr), /film/i, 'looking / none wording is translated')
  const de = createI18n({ catalogs, locale: 'de' }).getSnapshot().t
  assert.match(moviesFound({ movies: { count: 1204, done: true } }, de), /1\.204/, 'German thousands separator')
})

test('the screens the task names are extracted: sidebar, library toolbar, details, settings, get started, doctor', async () => {
  const { en } = loadCatalogs()
  const need = ['nav.movies', 'nav.settings', 'nav.group.library', 'sidebar.mode.pinned', 'footer.whatsNew', 'logout.title',
    'library.rescan', 'library.tabByDate', 'library.allGenres', 'view.button', 'viewmode.posters.label',
    'detail.play', 'detail.markWatched', 'detail.castCrew', 'settings.title', 'settings.moviesFolder', 'language.title',
    'firstrun.welcome', 'firstrun.step.folders', 'doctor.intro', 'doctor.fix.firewall.label', 'a11y.skipToContent']
  for (const key of need) assert.ok(en[key], `${key} is in en.json`)
})
