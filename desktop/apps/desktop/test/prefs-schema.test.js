'use strict'
// The preferences profile schema: closed and versioned. Unknown keys are rejected (never repaired), reserved
// keys never pass, values are range-checked, and old shapes migrate step by step.
const test = require('node:test')
const assert = require('node:assert/strict')
const kit = require('../electron/schemaKit')
const schema = require('../electron/prefsSchema')

test('defaults: a full validation of nothing yields the documented defaults', () => {
  const r = schema.validateLayers({}, {})
  assert.equal(r.ok, true)
  assert.equal(r.value.layout.density, 'comfortable')
  assert.equal(r.value.layout.cardStyle, 'classic')
  assert.equal(r.value.layout.radius, null)
  assert.equal(r.value.layout.posterAspect, '2:3')
  assert.equal(r.value.layout.fontScale, 1)
  assert.deepEqual(r.value.layout.sidebar, { mode: 'pinned', order: [], hidden: [] })
  assert.deepEqual(r.value.layout.home.shelves.map((s) => s.id), schema.SHELF_IDS)
  assert.ok(r.value.layout.home.shelves.every((s) => s.on === true))
  assert.deepEqual(r.value.view, { posterSize: 160, showTitles: true, showIcons: true, library: { mode: 'posters', sort: 'title' } })
  assert.deepEqual(r.value.access, { reduceMotion: 'system', largeText: false })
})

test('closed schema: an unknown key is an error at every depth, and nothing is repaired', () => {
  for (const bad of [
    { layout: { colour: 'red' } },
    { layout: { sidebar: { theme: 1 } } },
    { layout: { home: { shelves: [], extra: true } } },
    { notASection: {} },
    { access: { largeText: true, bogus: 1 } }
  ]) {
    const r = schema.validateLayers(bad, { partial: true })
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.match(r.errors.join(' '), /not a known setting/)
  }
})

test('values are range and enum checked', () => {
  const cases = [
    [{ layout: { density: 'huge' } }, /density/],
    [{ layout: { cardStyle: 'neon' } }, /cardStyle/],
    [{ layout: { radius: 29 } }, /radius/],
    [{ layout: { radius: -1 } }, /radius/],
    [{ layout: { radius: 3.5 } }, /radius/],
    [{ layout: { fontScale: 0.5 } }, /fontScale/],
    [{ layout: { fontScale: 2 } }, /fontScale/],
    [{ layout: { fontScale: '1.2' } }, /fontScale/],
    [{ layout: { fontScale: NaN } }, /fontScale/],
    [{ layout: { posterAspect: '4:3' } }, /posterAspect/],
    [{ layout: { sidebar: { mode: 'floating' } } }, /mode/],
    [{ layout: { sidebar: { order: ['movies', 'movies'] } } }, /twice/],
    [{ layout: { sidebar: { order: ['nope'] } } }, /unknown id/],
    [{ layout: { sidebar: { hidden: 'movies' } } }, /list/],
    [{ layout: { home: { shelves: [{ id: 'continue' }] } } }, /on/],
    [{ layout: { home: { shelves: [{ id: 'made-up', on: true }] } } }, /unknown row id/],
    [{ layout: { home: { shelves: [{ id: 'continue', on: true }, { id: 'continue', on: false }] } } }, /twice/],
    [{ layout: { home: { shelves: [{ id: 'continue', on: true, url: 'x' }] } } }, /not \{ id, on \}/],
    [{ view: { posterSize: 50 } }, /posterSize/],
    [{ view: { posterSize: 400 } }, /posterSize/],
    [{ view: { showTitles: 'yes' } }, /showTitles/],
    [{ access: { reduceMotion: true } }, /reduceMotion/],
    [{ access: { largeText: 1 } }, /largeText/]
  ]
  for (const [input, re] of cases) {
    const r = schema.validateLayers(input, { partial: true })
    assert.equal(r.ok, false, JSON.stringify(input))
    assert.match(r.errors.join(' '), re, JSON.stringify(input))
  }
})

test('font scale snaps to its step and stays in range; good values pass', () => {
  const r = schema.validateLayers({ layout: { fontScale: 1.13 }, view: { posterSize: 200 } }, { partial: true })
  assert.equal(r.ok, true)
  assert.equal(r.value.layout.fontScale, 1.15)
  assert.equal(r.value.view.posterSize, 200)
})

test('reserved keys and deep nesting never pass, at any depth', () => {
  const proto = JSON.parse('{"layout":{"__proto__":{"polluted":true}}}')
  assert.equal(schema.validateLayers(proto, { partial: true }).ok, false)
  assert.equal(({}).polluted, undefined)
  assert.equal(schema.validateProfile(JSON.parse('{"constructor":{"prototype":{"x":1}}}'), { partial: true }).ok, false)
  assert.equal(schema.validateProfile(JSON.parse('{"theme":{"custom":{"__proto__":"x"}}}'), { partial: true }).ok, false)
  let deep = { layout: {} }
  let cur = deep.layout
  for (let i = 0; i < 20; i++) { cur.a = {}; cur = cur.a }
  assert.equal(schema.validateLayers(deep, { partial: true }).ok, false)
  assert.equal(kit.mergePatch({}, JSON.parse('{"__proto__":{"polluted":1}}')).polluted, undefined)
  assert.equal(({}).polluted, undefined)
})

test('non-plain values are refused: arrays, class instances, functions', () => {
  assert.equal(schema.validateLayers([], { partial: true }).ok, false)
  assert.equal(schema.validateLayers({ layout: [] }, { partial: true }).ok, false)
  assert.equal(schema.validateLayers({ layout: new Date() }, { partial: true }).ok, false)
  assert.equal(schema.validateLayers({ layout: { density: () => 'compact' } }, { partial: true }).ok, false)
})

test('dropInvalid (reading storage): bad leaves are dropped, good ones kept, nothing throws', () => {
  const r = schema.validateLayers({ layout: { density: 'compact', radius: 999, junk: 1 }, view: { posterSize: 'big' }, evil: {} }, { partial: true, dropInvalid: true })
  assert.deepEqual(r.value, { layout: { density: 'compact' }, view: {} })
})

test('theme section: presets from the closed list, custom through the CSS sanitizer, pack origin shape', () => {
  assert.equal(schema.validateTheme({ preset: 'ember', custom: { '--purple': '#2a9d8f' }, pack: { id: 'beebo.dark', ver: '1.0.0' } }, {}).ok, true)
  assert.equal(schema.validateTheme({ preset: 'neon' }, { partial: true }).ok, false)
  assert.equal(schema.validateTheme({ custom: { '--evil': '#fff' } }, { partial: true }).ok, false)
  assert.equal(schema.validateTheme({ custom: { '--bg': 'url(http://x/y)' } }, { partial: true }).ok, false)
  assert.equal(schema.validateTheme({ pack: { id: 'x', ver: '1' } }, { partial: true }).ok, false)
  assert.equal(schema.validateTheme({ pack: { id: 'ok.pack', ver: '1.0.0', extra: 1 } }, { partial: true }).ok, false)
})

test('nav resolution: profile order first, the rest in default order, locked items never hidden, other client ids ignored', () => {
  const sidebar = { order: ['tvshows', 'movies', 'music', 'nonsense'], hidden: ['settings', 'users', 'appearance', 'upload'] }
  const app = schema.resolveNav(sidebar, 'desktop', ['getstarted', 'movies', 'tvshows', 'users', 'upload', 'settings'])
  assert.deepEqual(app, ['tvshows', 'movies', 'getstarted', 'settings'], 'users and upload hidden; settings is locked so it stays')
  const web = schema.resolveNav(sidebar, 'web', ['movies', 'music', 'tvshows', 'appearance', 'upload'])
  assert.deepEqual(web, ['tvshows', 'movies', 'music', 'appearance'])
  assert.deepEqual(schema.resolveNav(null, 'web', ['movies', 'appearance']), ['movies', 'appearance'])
})

test('shelf resolution: order and on/off; shelves the profile omits are on, at the end', () => {
  const shelves = schema.resolveShelves({ shelves: [{ id: 'trailers', on: true }, { id: 'recent', on: false }, { id: 'continue', on: true }] })
  assert.deepEqual(shelves, ['trailers', 'continue', 'watchlist', 'recommended', 'collections'])
  assert.deepEqual(schema.resolveShelves(null), schema.SHELF_IDS)
})

test('the designer guide lists exactly the registry\'s nav ids, shelf ids and enums (docs cannot drift)', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CUSTOMIZATION.md'), 'utf8')
  const line = /Nav ids: `([^`]+)`/.exec(doc)
  assert.ok(line, 'the guide has a "Nav ids:" line')
  assert.deepEqual(line[1].split(' '), schema.NAV_IDS)
  for (const id of schema.SHELF_IDS) assert.ok(doc.includes('`' + id + '`'), 'shelf ' + id)
  for (const v of [...schema.DENSITIES, ...schema.CARD_STYLES, ...schema.POSTER_ASPECTS, ...schema.SIDEBAR_MODES]) assert.ok(doc.includes(v), v)
})

// ---- migrations ----------------------------------------------------------------------------------------------

test('migration 0 -> 1: the desktop uiPrefs shape and a userThemes row both become a profile', () => {
  const ui = schema.migrate({ sidebarMode: 'hover', posterSize: 210.4, showPosterTitles: false, showPosterIcons: true }, 0)
  assert.equal(ui.ok, true)
  const v = schema.validateProfile(ui.data, { partial: true })
  assert.equal(v.ok, true, v.errors.join(';'))
  assert.equal(v.value.layout.sidebar.mode, 'hover')
  assert.equal(v.value.view.posterSize, 210)
  assert.equal(v.value.view.showTitles, false)
  const th = schema.migrate({ theme: 'ember', custom: { '--purple': '#123456' }, updatedAt: 5 }, 0)
  assert.deepEqual(th.data.theme, { preset: 'ember', custom: { '--purple': '#123456' } })
})

test('migration chain: steps run in order, one version at a time, and a hostile step cannot escape', () => {
  const log = []
  const steps = {
    0: (d) => { log.push('0->1'); return { ...d, a: 1 } },
    1: (d) => { log.push('1->2'); return { ...d, b: 2 } },
    2: (d) => { log.push('2->3'); return { ...d, c: 3 } }
  }
  const r = schema.migrate({}, 0, { steps, target: 3 })
  assert.deepEqual(log, ['0->1', '1->2', '2->3'])
  assert.deepEqual(r.data, { a: 1, b: 2, c: 3 })
  assert.deepEqual(schema.migrate({}, 2, { steps, target: 3 }).data, { c: 3 })
  assert.equal(schema.migrate({}, 1, { steps: { 1: () => { throw new Error('boom') } }, target: 2 }).ok, false)
  assert.equal(schema.migrate({}, 0, { steps: {}, target: 2 }).ok, false, 'a missing step is an error, not a silent skip')
})

test('a profile from a NEWER version is refused, never guessed at; bad versions are refused', () => {
  const newer = schema.migrate({}, schema.CURRENT_VERSION + 1)
  assert.equal(newer.ok, false)
  assert.match(newer.error, /newer version/)
  for (const bad of [-1, 1.5, '1', null, undefined, NaN]) assert.equal(schema.migrate({}, bad).ok, false, String(bad))
  assert.equal(schema.migrate({ layout: {} }, schema.CURRENT_VERSION).ok, true)
})
