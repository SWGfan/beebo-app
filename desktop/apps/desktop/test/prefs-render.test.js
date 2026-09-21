'use strict'
// What a profile becomes on the page: attributes on <html> and tokens (CSS variables). Only non-default choices
// produce anything; every value is from a closed set; Reduce motion and Large text are wired to tokens.
const test = require('node:test')
const assert = require('node:assert/strict')
const render = require('../electron/prefsRender')
const schema = require('../electron/prefsSchema')
const theme = require('../electron/theme')

const eff = (layout = {}, access = {}) => ({
  layout: { ...schema.DEFAULTS.layout, ...layout },
  access: { ...schema.DEFAULTS.access, ...access }
})

test('defaults render nothing: no attributes, no variables, no CSS', () => {
  const spec = render.renderSpec(eff())
  assert.deepEqual(spec, { attrs: {}, vars: {} })
  assert.equal(render.htmlAttrs(spec), '')
  assert.equal(render.css(spec), '')
  assert.deepEqual(render.renderSpec(null), { attrs: {}, vars: {} })
})

test('each layout choice maps to one attribute and, where needed, a token', () => {
  const s = render.renderSpec(eff({ density: 'compact', cardStyle: 'floating', posterAspect: '16:9', radius: 20, fontScale: 1.1 }))
  assert.deepEqual(s.attrs, { 'data-density': 'compact', 'data-card-style': 'floating', 'data-poster-aspect': '16-9', 'data-radius': 'custom', 'data-font-scale': 'custom' })
  assert.equal(s.vars['--poster-aspect'], '16/9')
  assert.deepEqual([s.vars['--radius-card'], s.vars['--radius-control'], s.vars['--radius-button']], ['20px', '16px', '14px'])
  assert.equal(s.vars['--ui-font-scale'], '1.1')
})

test('Large text raises the text scale to at least 125% and never lowers a bigger one; both are tokens', () => {
  assert.equal(render.renderSpec(eff({}, { largeText: true })).vars['--ui-font-scale'], '1.25')
  assert.equal(render.renderSpec(eff({ fontScale: 1.5 }, { largeText: true })).vars['--ui-font-scale'], '1.5')
  assert.equal(render.renderSpec(eff({ fontScale: 0.9 }, { largeText: true })).vars['--ui-font-scale'], '1.25')
  const s = render.renderSpec(eff({}, { largeText: true }))
  assert.equal(s.attrs['data-large-text'], '1')
  assert.match(render.css(s), /:root\[data-font-scale\] body\{font-size:calc\(14px\*var\(--ui-font-scale\)\)\}/)
})

test('Reduce motion: "on" sets the attribute and the token and switches off animation, transition and hover movement; "system" and "off" add nothing', () => {
  const on = render.renderSpec(eff({}, { reduceMotion: 'on' }))
  assert.equal(on.attrs['data-reduce-motion'], '1')
  assert.equal(on.vars['--ui-motion'], '0')
  const css = render.css(on)
  assert.match(css, /animation:none!important;transition:none!important;scroll-behavior:auto!important/)
  assert.match(css, /\.card:hover\{transform:none!important\}/)
  for (const v of ['system', 'off']) assert.deepEqual(render.renderSpec(eff({}, { reduceMotion: v })), { attrs: {}, vars: {} })
})

test('the CSS only contains rules for attributes that are set, and only allow-listed characters', () => {
  const css = render.css(render.renderSpec(eff({ density: 'compact' })))
  assert.ok(css.includes('data-density=compact'))
  assert.ok(!css.includes('data-density=spacious'))
  assert.ok(!css.includes('data-card-style'))
  assert.ok(!css.includes('data-reduce-motion'))
  const all = render.css(render.renderSpec(eff({ density: 'spacious', cardStyle: 'outlined', posterAspect: '1:1', radius: 8, fontScale: 1.3 }, { reduceMotion: 'on', largeText: true })))
  assert.ok(!/[<]|url\(|@import|expression|javascript|\\/.test(all))
  assert.ok(/^[\x20-\x7e\n]*$/.test(all), 'plain ASCII')
})

test('a radius set in the layout beats a theme\'s own radius (higher specificity), and is emitted after it', () => {
  const css = render.css(render.renderSpec(eff({ radius: 6 })))
  assert.match(css, /:root\[data-theme\]\[data-radius\]\{--radius-card:6px;--radius-control:5px;--radius-button:4px;\}/)
})

test('htmlAttrs drops anything that is not a plain data attribute with a plain value', () => {
  assert.equal(render.htmlAttrs({ attrs: { 'data-x': 'a"b', 'onclick': 'x', 'data-ok': 'fine', 'data-Bad': 'x' }, vars: {} }), ' data-ok="fine"')
  assert.equal(render.css({ attrs: { 'data-density': 'compact' }, vars: { '--evil': 'url(x)', '--ui-font-scale': '1.2;color:red' } }).includes('url'), false)
  assert.ok(!render.css({ attrs: { 'data-density': 'compact' }, vars: { '--ui-font-scale': '1.2;color:red' } }).includes('color:red'))
})

test('augment adds attributes and CSS to theme render info, and leaves the default info untouched', () => {
  const base = theme.renderInfo({ theme: 'midnight', custom: {} })
  const holder = { store: { get: () => undefined }, userId: 'ann', safe: false }
  const same = render.augment(JSON.parse(JSON.stringify(base)), holder)
  assert.deepEqual(same, base, 'with nothing saved nothing is added, not even an empty attrs key')
  const store = { data: {}, get(k) { return this.data[k] }, set(k, v) { this.data[k] = JSON.parse(JSON.stringify(v)) } }
  require('../electron/prefsStore').patch(store, 'ann', { layout: { density: 'compact' } })
  const info = render.augment(JSON.parse(JSON.stringify(base)), { store, userId: 'ann', safe: false })
  assert.equal(info.attrs, ' data-density="compact"')
  assert.ok(info.css.includes('data-density=compact'))
  const safe = render.augment(JSON.parse(JSON.stringify(base)), { store, userId: 'ann', safe: true })
  assert.deepEqual(safe, base, 'safe mode renders the defaults')
  const other = render.augment(JSON.parse(JSON.stringify(base)), { store, userId: 'bob', safe: false })
  assert.deepEqual(other, base, 'another person\'s render is unaffected')
})

test('webNav applies the person\'s order and hidden items to the default list, outside a request it changes nothing', () => {
  const list = ['movies', 'tvshows', 'appearance', 'admin']
  assert.deepEqual(render.webNav(list), list)
  const store = { data: {}, get(k) { return this.data[k] }, set(k, v) { this.data[k] = JSON.parse(JSON.stringify(v)) } }
  require('../electron/prefsStore').patch(store, 'ann', { layout: { sidebar: { order: ['tvshows'], hidden: ['admin', 'appearance'] } } })
  theme.runWithScope(() => {
    theme.setRequestUser(store, 'ann')
    assert.deepEqual(render.webNav(list), ['tvshows', 'movies', 'appearance'])
  })
  theme.runWithScope(() => {
    theme.setRequestUser(store, 'bob')
    assert.deepEqual(render.webNav(list), list)
  })
})
