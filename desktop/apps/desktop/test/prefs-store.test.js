'use strict'
// The per-user profile store: isolation between people, sparse layers, merge-patch, optimistic concurrency,
// reset, export/import roundtrip, packs, household layer, hostile stored data, and purge.
const test = require('node:test')
const assert = require('node:assert/strict')
const prefs = require('../electron/prefsStore')
const theme = require('../electron/theme')
const schema = require('../electron/prefsSchema')
const packs = require('../electron/packs')
const userDeletion = require('../electron/userDeletion')

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial))
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
}

test('nothing saved: defaults, personal, revision 0, and reading never writes', () => {
  const store = makeStore()
  const d = prefs.describe(store, 'ann')
  assert.equal(d.personal, true)
  assert.equal(d.effective.layout.density, 'comfortable')
  assert.deepEqual(d.effective.theme, { preset: 'midnight', custom: {}, pack: null })
  assert.match(d.rev, /^0\.0$/)
  assert.deepEqual(d.render, { attrs: {}, vars: {} }, 'defaults render nothing')
  assert.deepEqual(store.data, {})
})

test('patch stores ONLY what changed (sparse) under userPrefs[userId], versioned', () => {
  const store = makeStore()
  const r = prefs.patch(store, 'ann', { layout: { density: 'compact' }, access: { largeText: true } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(Object.keys(store.data), ['userPrefs'])
  const row = store.data.userPrefs.ann
  assert.equal(row.v, schema.CURRENT_VERSION)
  assert.equal(row.rev, 1)
  assert.deepEqual(row.data, { layout: { density: 'compact' }, access: { largeText: true } })
  assert.equal(r.state.effective.layout.density, 'compact')
  assert.equal(r.state.effective.layout.cardStyle, 'classic', 'untouched keys keep their default')
})

test('merge-patch semantics: objects merge, lists replace, null reverts a key to the default', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact', sidebar: { order: ['tvshows', 'movies'], hidden: ['getapp'] } } })
  prefs.patch(store, 'ann', { layout: { sidebar: { order: ['movies'] } } })
  let l = prefs.describe(store, 'ann').effective.layout
  assert.deepEqual(l.sidebar.order, ['movies'], 'the list was replaced')
  assert.deepEqual(l.sidebar.hidden, ['getapp'], 'a sibling was kept')
  assert.equal(l.density, 'compact')
  prefs.patch(store, 'ann', { layout: { density: null } })
  l = prefs.describe(store, 'ann').effective.layout
  assert.equal(l.density, 'comfortable', 'null returns the key to the default')
  prefs.patch(store, 'ann', { layout: null })
  assert.deepEqual(prefs.readRow(store, 'ann').data, {}, 'a section set to null is reset')
})

test('all-or-nothing: one invalid part rejects the whole patch and nothing is stored', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact' } })
  const before = JSON.stringify(store.data)
  const bad = [
    { layout: { density: 'spacious' }, access: { largeText: 'yes' } },
    { layout: { density: 'spacious' }, view: { posterSize: 5 } },
    { layout: { density: 'spacious' }, theme: { preset: 'nope' } },
    { layout: { density: 'spacious' }, theme: { custom: { '--bg': 'url(http://x)' } } },
    { layout: { density: 'spacious' }, theme: { custom: { '--text': '#101010', '--bg': '#111111' } } }, // unreadable
    { layout: { density: 'spacious' }, unknown: {} },
    {}
  ]
  for (const body of bad) {
    const r = prefs.patch(store, 'ann', body)
    assert.equal(r.ok, false, JSON.stringify(body))
    assert.equal(JSON.stringify(store.data), before, 'unchanged after ' + JSON.stringify(body))
  }
})

test('per-user isolation: one person\'s choices never reach another, in either direction', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact' }, access: { reduceMotion: 'on' }, theme: { preset: 'daylight' } })
  prefs.patch(store, 'bob', { layout: { density: 'spacious', cardStyle: 'floating' } })
  const ann = prefs.describe(store, 'ann').effective
  const bob = prefs.describe(store, 'bob').effective
  const cat = prefs.describe(store, 'cat').effective
  assert.equal(ann.layout.density, 'compact')
  assert.equal(ann.access.reduceMotion, 'on')
  assert.equal(ann.theme.preset, 'daylight')
  assert.equal(bob.layout.density, 'spacious')
  assert.equal(bob.layout.cardStyle, 'floating')
  assert.equal(bob.access.reduceMotion, 'system')
  assert.equal(bob.theme.preset, 'midnight')
  assert.equal(cat.layout.density, 'comfortable', 'someone who never saved anything is untouched')
  assert.deepEqual(Object.keys(store.data.userPrefs).sort(), ['ann', 'bob'])
  // resetting Bob leaves Ann alone
  prefs.reset(store, 'bob', 'all')
  assert.equal(prefs.describe(store, 'ann').effective.layout.density, 'compact')
  assert.equal(prefs.describe(store, 'bob').effective.layout.cardStyle, 'classic')
  // export of one person contains nothing of another
  const exp = JSON.stringify(prefs.exportProfile(store, 'bob'))
  assert.ok(!exp.includes('daylight') && !exp.includes('"compact"'))
})

test('ids that are not accounts (guests, empty, reserved) get defaults and can never write', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact' } })
  for (const id of ['share:abc', '', null, undefined, '__proto__', 'constructor', 'a/b', 'x'.repeat(200), 42, {}]) {
    assert.equal(prefs.describe(store, id).personal, false, String(id))
    assert.equal(prefs.describe(store, id).effective.layout.density, 'comfortable')
    for (const r of [prefs.patch(store, id, { layout: { density: 'spacious' } }), prefs.reset(store, id), prefs.importFile(store, id, { format: 'beebo-profile', v: 1, profile: {} }), prefs.applyBundled(store, id, 'layout', 'beebo.classic')]) {
      assert.equal(r.ok, false)
      assert.equal(r.status, 403)
    }
  }
  assert.deepEqual(Object.keys(store.data), ['userPrefs'])
  assert.deepEqual(Object.keys(store.data.userPrefs), ['ann'])
  assert.equal(({}).density, undefined)
})

test('optimistic concurrency: a stale If-Match gets a conflict and changes nothing; a current one wins', () => {
  const store = makeStore()
  const first = prefs.patch(store, 'ann', { layout: { density: 'compact' } })
  const rev1 = first.state.rev
  const second = prefs.patch(store, 'ann', { layout: { density: 'spacious' } }, { ifMatch: rev1 })
  assert.equal(second.ok, true)
  assert.notEqual(second.state.rev, rev1)
  const stale = prefs.patch(store, 'ann', { layout: { density: 'compact' } }, { ifMatch: rev1 })
  assert.equal(stale.ok, false)
  assert.equal(stale.status, 409)
  assert.equal(stale.error, 'conflict')
  assert.equal(prefs.describe(store, 'ann').effective.layout.density, 'spacious')
  assert.equal(prefs.patch(store, 'ann', { layout: { density: 'compact' } }, { ifMatch: `"${second.state.rev}"` }).ok, true, 'quoted / ETag-style values are accepted')
  assert.equal(prefs.reset(store, 'ann', 'layout', { ifMatch: rev1 }).status, 409)
  assert.equal(prefs.importFile(store, 'ann', prefs.exportProfile(store, 'ann'), { ifMatch: rev1 }).status, 409)
})

test('the revision also moves when the theme changes through the OLD /api/theme path', () => {
  const store = makeStore()
  const a = prefs.describe(store, 'ann').rev
  theme.saveUserTheme(store, 'ann', { theme: 'ember' })
  const b = prefs.describe(store, 'ann').rev
  assert.notEqual(a, b)
  assert.equal(prefs.describe(store, 'ann').effective.theme.preset, 'ember', 'the profile sees a theme saved the old way')
})

test('reset: one section, or everything, including the theme; sections not named are kept', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact' }, view: { posterSize: 250 }, access: { largeText: true }, theme: { preset: 'ember' } })
  prefs.reset(store, 'ann', 'view')
  let e = prefs.describe(store, 'ann').effective
  assert.equal(e.view.posterSize, 160)
  assert.equal(e.layout.density, 'compact')
  assert.equal(e.access.largeText, true)
  prefs.reset(store, 'ann', 'theme')
  assert.equal(prefs.describe(store, 'ann').effective.theme.preset, 'midnight')
  assert.equal(store.data.userThemes, undefined, 'the color row is gone too')
  prefs.reset(store, 'ann', 'all')
  e = prefs.describe(store, 'ann').effective
  assert.deepEqual([e.layout.density, e.access.largeText], ['comfortable', false])
  assert.equal(prefs.reset(store, 'ann', 'everything').ok, false)
  assert.equal(prefs.reset(store, 'ann', '__proto__').ok, false)
})

test('household layer: defaults < household < person, per key; admin changes propagate to people who have not overridden', () => {
  const store = makeStore()
  assert.equal(prefs.setHousehold(store, { layout: { density: 'spacious', cardStyle: 'flat' }, access: { largeText: true } }).ok, true)
  prefs.patch(store, 'ann', { layout: { cardStyle: 'floating' } })
  const ann = prefs.describe(store, 'ann').effective
  const bob = prefs.describe(store, 'bob').effective
  assert.equal(ann.layout.density, 'spacious', 'inherits the household density')
  assert.equal(ann.layout.cardStyle, 'floating', 'her own choice wins')
  assert.equal(bob.layout.cardStyle, 'flat')
  assert.equal(bob.access.largeText, true)
  prefs.setHousehold(store, { layout: { density: 'compact' } })
  assert.equal(prefs.describe(store, 'bob').effective.layout.density, 'compact', 'a change reaches everyone who has not overridden')
  assert.equal(prefs.describe(store, 'ann').effective.layout.cardStyle, 'floating')
  assert.equal(prefs.describe(store, 'share:x').effective.layout.density, 'compact', 'guests see the household defaults')
  assert.equal(prefs.setHousehold(store, { theme: { preset: 'ember' } }).ok, false, 'colors are personal, not a household default')
  assert.equal(prefs.setHousehold(store, { layout: { density: 'nope' } }).ok, false)
  assert.equal(prefs.setHousehold(store, { layout: null, access: null }).ok, true)
  assert.equal(prefs.describe(store, 'bob').effective.layout.density, 'comfortable')
})

test('a hand-edited store cannot inject anything: rows are re-validated on every read', () => {
  const store = makeStore({
    userPrefs: {
      ann: { v: 1, rev: 3, data: { layout: { density: 'compact', radius: 500, evil: '<script>', sidebar: { order: ['movies', 'x'], hidden: ['getapp'] } }, view: { posterSize: 'huge' }, access: { largeText: 'yes', reduceMotion: 'on' }, theme: { pack: { id: 'a.b', ver: '1.0.0' } } }, themeStamp: 0 },
      bob: { v: 99, rev: 1, data: { layout: { density: 'compact' } } },
      cat: 'not an object',
      dan: { v: 1, rev: 'x', data: [1, 2, 3] },
      '__proto__': { v: 1, rev: 1, data: { layout: { density: 'compact' } } }
    },
    householdPrefs: { data: { layout: { fontScale: 99, density: 'spacious' }, evil: 1 } }
  })
  const ann = prefs.describe(store, 'ann').effective
  assert.equal(ann.layout.density, 'compact', 'the good leaf survives')
  assert.equal(ann.layout.radius, null, 'the out-of-range leaf was dropped')
  assert.equal(ann.layout.fontScale, 1, 'the household\'s bad leaf was dropped too')
  assert.deepEqual(ann.layout.sidebar.order, [], 'a list with an unknown id is dropped whole')
  assert.deepEqual(ann.layout.sidebar.hidden, ['getapp'])
  assert.equal(ann.view.posterSize, 160)
  assert.equal(ann.access.largeText, false)
  assert.equal(ann.access.reduceMotion, 'on')
  assert.equal(prefs.describe(store, 'bob').effective.layout.density, 'spacious', 'a row from a newer version is ignored (household still applies)')
  assert.equal(prefs.describe(store, 'cat').effective.layout.density, 'spacious')
  assert.equal(prefs.describe(store, 'dan').effective.layout.density, 'spacious')
  assert.equal(prefs.describe(store, '__proto__').personal, false)
  assert.ok(!JSON.stringify(prefs.describe(store, 'ann')).includes('<script>'))
})

test('row size is capped: an oversized write is refused and the stored row is untouched', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact' } })
  const before = JSON.stringify(store.data)
  // the schema itself bounds every list, so the cap is a backstop: prove it by lowering the limit
  prefs._setRowLimit(20)
  try {
    const r = prefs.patch(store, 'ann', { layout: { density: 'spacious' } })
    assert.equal(r.ok, false)
    assert.equal(r.status, 413)
  } finally { prefs._setRowLimit(schema.LIMITS.maxRowBytes) }
  assert.equal(JSON.stringify(store.data), before)
})

// ---- export / import -----------------------------------------------------------------------------------------------

test('export -> import roundtrip reproduces the profile exactly, on a different account and a different store', () => {
  const a = makeStore()
  prefs.patch(a, 'ann', {
    layout: { density: 'spacious', cardStyle: 'outlined', radius: 20, posterAspect: '16:9', fontScale: 1.3, sidebar: { mode: 'hover', order: ['tvshows', 'movies'], hidden: ['getapp', 'suggest'] }, home: { shelves: [{ id: 'trailers', on: true }, { id: 'continue', on: false }] } },
    view: { posterSize: 220, showTitles: false, library: { mode: 'table', sort: 'year' } },
    access: { reduceMotion: 'on', largeText: true },
    theme: { preset: 'ember', custom: { '--purple': '#2a9d8f', '--radius-card': '18px' } }
  })
  const file = prefs.exportProfile(a, 'ann')
  assert.equal(file.format, 'beebo-profile')
  assert.equal(file.v, 1)
  const text = JSON.stringify(file)
  assert.ok(Buffer.byteLength(text) < 256 * 1024)
  assert.ok(!/token|password|secret|email|userId|"ann"/i.test(text), 'no ids, tokens or secrets in an export')

  const b = makeStore()
  const dry = prefs.importFile(b, 'zed', JSON.parse(text), { dryRun: true })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.ok(dry.diff.length > 5, 'the preview lists what would change')
  assert.deepEqual(b.data, {}, 'a dry run writes nothing')
  const applied = prefs.importFile(b, 'zed', JSON.parse(text))
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.deepEqual(prefs.describe(b, 'zed').effective, prefs.describe(a, 'ann').effective)
  assert.deepEqual(prefs.exportProfile(b, 'zed').profile, file.profile)
  assert.equal(prefs.describe(b, 'ann').effective.layout.density, 'comfortable', 'importing for zed did not touch anyone else')
})

test('import refuses hostile and malformed profile files without changing anything', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact' } })
  const before = JSON.stringify(store.data)
  const good = prefs.exportProfile(store, 'ann')
  const mutate = (fn) => { const f = JSON.parse(JSON.stringify(good)); fn(f); return f }
  const cases = [
    null, 'text', [], {}, { format: 'other', v: 1, profile: {} },
    mutate((f) => { f.v = 99 }), mutate((f) => { f.v = 'one' }), mutate((f) => { delete f.v }), mutate((f) => { f.v = -1 }),
    mutate((f) => { f.extra = 1 }),
    mutate((f) => { f.profile.layout.density = 'huge' }),
    mutate((f) => { f.profile.layout.customCss = 'a{}' }),
    mutate((f) => { f.profile.theme.custom['--bg'] = 'url(https://evil.example/x)' }),
    mutate((f) => { f.profile.theme.custom = { '--text': '#111111', '--bg': '#121212' } }),
    mutate((f) => { f.profile.theme.preset = 'nope' }),
    mutate((f) => { f.profile.layout.sidebar.order = ['movies', 'https://phish.example'] }),
    mutate((f) => { f.profile = JSON.parse('{"layout":{"__proto__":{"polluted":true}}}') }),
    mutate((f) => { f.profile.access = { largeText: 'yes' } })
  ]
  for (const file of cases) {
    for (const dryRun of [true, false]) {
      const r = prefs.importFile(store, 'ann', file, { dryRun })
      assert.equal(r.ok, false, JSON.stringify(file).slice(0, 80))
    }
  }
  assert.equal(JSON.stringify(store.data), before)
  assert.equal(({}).polluted, undefined)
})

test('a legacy (version 0) profile file migrates on import; a newer one is refused with a clear message', () => {
  const store = makeStore()
  const legacy = { format: 'beebo-profile', v: 0, profile: { sidebarMode: 'hidden', posterSize: 240, showPosterTitles: false } }
  const r = prefs.importFile(store, 'ann', legacy)
  assert.equal(r.ok, true, JSON.stringify(r))
  const e = prefs.describe(store, 'ann').effective
  assert.equal(e.layout.sidebar.mode, 'hidden')
  assert.equal(e.view.posterSize, 240)
  assert.equal(e.view.showTitles, false)
  const newer = prefs.importFile(store, 'ann', { format: 'beebo-profile', v: 2, profile: {} })
  assert.equal(newer.ok, false)
  assert.match(newer.errors.join(' '), /newer version/)
})

test('a stored row from an older version migrates when read', () => {
  const store = makeStore({ userPrefs: { ann: { v: 0, rev: 2, data: { sidebarMode: 'hover', posterSize: 180 } } } })
  const e = prefs.describe(store, 'ann').effective
  assert.equal(e.layout.sidebar.mode, 'hover')
  assert.equal(e.view.posterSize, 180)
})

// ---- packs ---------------------------------------------------------------------------------------------------------

test('applying a layout pack replaces the layout section, records its origin, and leaves accessibility alone', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { access: { largeText: true, reduceMotion: 'on' }, layout: { fontScale: 1.4, density: 'spacious' } })
  const r = prefs.applyBundled(store, 'ann', 'layout', 'beebo.compact-library')
  assert.equal(r.ok, true)
  const e = prefs.describe(store, 'ann').effective
  assert.equal(e.layout.density, 'compact')
  assert.equal(e.layout.fontScale, 0.95, 'the pack replaced the whole section, including the earlier text size')
  assert.deepEqual(e.layout.pack, { id: 'beebo.compact-library', ver: '1.0.0' })
  assert.deepEqual([e.access.largeText, e.access.reduceMotion], [true, 'on'], 'a pack never touches accessibility')
  assert.equal(prefs.applyBundled(store, 'ann', 'layout', 'nope.pack').status, 404)
  assert.equal(prefs.applyBundled(store, 'ann', 'layout', '__proto__').status, 404)
})

test('applying a theme pack stores its variables with the origin; changing the theme another way clears the origin', () => {
  const store = makeStore()
  const r = prefs.applyBundled(store, 'ann', 'theme', 'beebo.oled-black')
  assert.equal(r.ok, true, JSON.stringify(r))
  let e = prefs.describe(store, 'ann').effective
  assert.deepEqual(e.theme.pack, { id: 'beebo.oled-black', ver: '1.0.0' })
  assert.equal(e.theme.custom['--bg'], '#000000')
  assert.equal(e.theme.preset, 'graphite', 'a dark pack sits on a dark base for the values it does not set')
  const info = theme.renderInfo(theme.getUserTheme(store, 'ann'))
  assert.equal(info.themeColor, '#000000', 'the phone browser bar follows the pack\'s background')
  assert.ok(info.css.includes('--bg:#000000;'))
  theme.saveUserTheme(store, 'ann', { theme: 'ember' }) // the old path
  e = prefs.describe(store, 'ann').effective
  assert.equal(e.theme.pack, null, 'origin is dropped once the colors are no longer the pack\'s')
  const light = prefs.applyBundled(store, 'bob', 'theme', 'beebo.light')
  assert.equal(light.ok, true)
  assert.equal(prefs.describe(store, 'bob').effective.theme.preset, 'daylight')
  assert.equal(prefs.describe(store, 'ann').effective.theme.custom['--bg'], '#000000', 'Ann keeps her own colors: Bob\'s light pack did not touch them')
})

test('import of a theme pack file: preview shows contrast warnings and the fix; apply with autoFix stores fixed colors', () => {
  const store = makeStore()
  const pack = JSON.parse(JSON.stringify(packs.toFile(packs.findBundled('theme', 'beebo.dark'))))
  delete pack.integrity
  pack.id = 'designer.muddy'
  pack.content.vars['--text'] = '#6b6c72'
  pack.content.vars['--muted'] = '#66676d'
  const dry = prefs.importFile(store, 'ann', pack, { dryRun: true })
  assert.equal(dry.ok, true, JSON.stringify(dry))
  assert.ok(dry.themeCheck.warnings.length >= 2)
  assert.equal(dry.themeCheck.fixable, true)
  assert.deepEqual(store.data, {})
  const plain = prefs.importFile(store, 'ann', pack)
  assert.equal(plain.ok, true, 'a designer\'s low-contrast pack can still be applied as drawn (only the 3:1 unreadable floor blocks)')
  assert.equal(prefs.describe(store, 'ann').effective.theme.custom['--text'], '#6b6c72')
  const fixed = prefs.importFile(store, 'bob', pack, { autoFix: true })
  assert.equal(fixed.ok, true)
  const t = prefs.describe(store, 'bob').effective.theme
  assert.notEqual(t.custom['--text'], '#6b6c72')
  assert.equal(require('../electron/themeContrast').check(t.preset, t.custom).failures.length, 0)
  assert.deepEqual(t.pack, { id: 'designer.muddy', ver: '1.0.0' })
  // a pack whose text would be unreadable (under 3:1) is refused outright
  const unreadable = JSON.parse(JSON.stringify(pack)); unreadable.id = 'designer.blank'; unreadable.content.vars['--text'] = '#101010'; unreadable.content.vars['--bg'] = '#111111'
  assert.equal(prefs.importFile(makeStore(), 'cat', unreadable).ok, false)
})

test('checkTheme reports warnings and the fixed variables for the editor', () => {
  const r = prefs.checkTheme('graphite', { '--text': '#6b6c72' })
  assert.equal(r.ok, true)
  assert.ok(r.warnings.length >= 1)
  assert.equal(r.fixable, true)
  assert.notEqual(r.fixedVars['--text'], '#6b6c72')
  assert.equal(prefs.checkTheme('graphite', { '--text': 'url(x)' }).ok, false)
  assert.equal(prefs.checkTheme('nope', {}).ok, true, 'an unknown preset falls back to the default')
})

// ---- preview, purge, backup, other surfaces -----------------------------------------------------------------------

test('preview: what a patch would look like, validated the same way, and never saved', () => {
  const store = makeStore()
  prefs.patch(store, 'ann', { layout: { density: 'compact' } })
  const before = JSON.stringify(store.data)
  const r = prefs.preview(store, 'ann', { layout: { fontScale: 1.5 }, access: { reduceMotion: 'on' } })
  assert.equal(r.ok, true)
  assert.equal(r.spec.attrs['data-density'], 'compact', 'the saved layer is the starting point')
  assert.equal(r.spec.attrs['data-font-scale'], 'custom')
  assert.equal(r.spec.vars['--ui-font-scale'], '1.5')
  assert.equal(r.spec.attrs['data-reduce-motion'], '1')
  assert.match(r.css, /--ui-font-scale:1\.5;/)
  assert.equal(JSON.stringify(store.data), before)
  assert.equal(prefs.preview(store, 'ann', { layout: { density: 'nope' } }).ok, false)
  assert.equal(prefs.preview(store, 'ann', { theme: { preset: 'ember' } }).ok, false)
})

test('account deletion purges the person\'s profile and nobody else\'s; backups list the new keys', () => {
  const store = makeStore({ authUsers: [{ id: 'ann' }, { id: 'bob' }] })
  prefs.patch(store, 'ann', { layout: { density: 'compact' } })
  prefs.patch(store, 'bob', { layout: { density: 'spacious' } })
  userDeletion.purgeUserData(store, 'ann')
  assert.deepEqual(Object.keys(store.data.userPrefs), ['bob'])
  const backup = require('../electron/backup')
  const section = (backup.BACKUP_SECTIONS || []).find((s) => s.keys && s.keys.includes('userPrefs'))
  if (backup.BACKUP_SECTIONS) assert.ok(section && section.keys.includes('householdPrefs') && section.keys.includes('userThemes'))
  prefs.removeUser(store, 'bob')
  assert.equal(store.data.userPrefs, undefined)
})

test('the profile is nowhere near the public API contract or webhooks', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  for (const file of ['publicApi.js', 'webhooks.js', 'playbackApi.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron', file), 'utf8')
    assert.ok(!/userPrefs|prefsStore|householdPrefs/.test(src), file + ' must not touch preferences')
  }
})
