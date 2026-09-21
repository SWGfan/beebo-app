'use strict'
// The shipped default packs (4 themes, 3 layouts), pack file integrity, and the WCAG contrast checker + fixer.
const test = require('node:test')
const assert = require('node:assert/strict')
const packs = require('../electron/packs')
const contrast = require('../electron/themeContrast')
const theme = require('../electron/theme')
const schema = require('../electron/prefsSchema')

const bundled = packs.loadBundled({ force: true })
const themeById = (id) => bundled.theme.find((p) => p.id === id)

test('the bundled packs all load with no problems: 4 themes and 3 layouts', () => {
  assert.deepEqual(bundled.problems, [])
  assert.deepEqual(bundled.theme.map((p) => p.id).sort(), ['beebo.dark', 'beebo.high-contrast', 'beebo.light', 'beebo.oled-black'])
  assert.deepEqual(bundled.layout.map((p) => p.id).sort(), ['beebo.cinematic-shelves', 'beebo.classic', 'beebo.compact-library'])
  for (const p of [...bundled.theme, ...bundled.layout]) {
    assert.equal(p.license, 'CC0-1.0', p.id + ' is free for a designer to replace')
    assert.match(p.version, /^\d+\.\d+\.\d+$/)
    assert.ok(p.description.length > 10)
  }
})

test('theme packs are complete token sets: every non-derived variable, in the registry, valid', () => {
  for (const p of bundled.theme) {
    for (const tok of theme.TOKENS) {
      if (tok.derived) continue
      assert.ok(tok.name in p.content.vars, `${p.id} defines ${tok.name}`)
    }
    assert.equal(Object.keys(p.content.vars).length, theme.TOKENS.filter((t) => !t.derived).length, p.id + ' has no extras')
  }
})

test('theme packs meet WCAG AA on every checked pair; high contrast meets AAA (7:1)', () => {
  for (const p of bundled.theme) {
    const base = packs.baseOf(p)
    const r = contrast.check(base, p.content.vars)
    assert.equal(r.failures.length, 0, `${p.id}: ${JSON.stringify(r.failures.slice(0, 3))}`)
    assert.ok(r.checked >= 45, 'the checker covered the pairs')
  }
  const hc = themeById('beebo.high-contrast')
  assert.deepEqual(contrast.check(packs.baseOf(hc), hc.content.vars, { level: 'AAA' }).failures, [])
})

test('the four themes are what they claim: light is light, OLED is true black, high contrast is black and white', () => {
  assert.equal(themeById('beebo.light').content.scheme, 'light')
  for (const id of ['beebo.dark', 'beebo.oled-black', 'beebo.high-contrast']) assert.equal(themeById(id).content.scheme, 'dark')
  assert.equal(themeById('beebo.oled-black').content.vars['--bg'], '#000000')
  assert.equal(themeById('beebo.oled-black').content.themeColor, '#000000')
  const hc = themeById('beebo.high-contrast').content.vars
  assert.equal(hc['--bg'], '#000000')
  assert.equal(hc['--text'], '#ffffff')
  assert.ok(contrast.ratio([255, 255, 255], [0, 0, 0]) >= 21 - 0.01)
})

test('layout packs are distinct, complete enough to preview, and only reference registry ids', () => {
  const [classic, cinematic, compact] = ['beebo.classic', 'beebo.cinematic-shelves', 'beebo.compact-library'].map((id) => bundled.layout.find((p) => p.id === id))
  assert.equal(classic.content.density, 'comfortable')
  assert.equal(cinematic.content.density, 'spacious')
  assert.equal(compact.content.density, 'compact')
  assert.notEqual(cinematic.content.cardStyle, compact.content.cardStyle)
  assert.equal(cinematic.content.home.shelves[1].id, 'trailers', 'cinematic puts trailers up front')
  assert.ok(compact.content.home.shelves.filter((s) => s.on).length < classic.content.home.shelves.filter((s) => s.on).length)
  for (const p of bundled.layout) {
    for (const id of [...p.content.sidebar.order, ...p.content.sidebar.hidden]) assert.ok(schema.NAV_IDS.includes(id), id)
    for (const locked of schema.LOCKED_NAV) assert.ok(!p.content.sidebar.hidden.includes(locked), p.id + ' never hides ' + locked)
  }
})

test('pack file roundtrip: toFile adds an integrity hash that validates; any change to the content breaks it', () => {
  const p = themeById('beebo.dark')
  const file = packs.toFile(p)
  assert.match(file.integrity, /^sha256-[A-Za-z0-9+/]{43}=$/)
  const again = packs.validatePack(JSON.parse(JSON.stringify(file)))
  assert.equal(again.ok, true, again.errors.join(';'))
  assert.deepEqual(again.pack.content, p.content)
  const tampered = JSON.parse(JSON.stringify(file))
  tampered.content.vars['--bg'] = '#010101'
  const r = packs.validatePack(tampered)
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /integrity/)
  // key order does not matter to the hash
  const reordered = JSON.parse(JSON.stringify(file))
  reordered.content = Object.fromEntries(Object.entries(reordered.content).reverse())
  assert.equal(packs.validatePack(reordered).ok, true)
})

test('validatePack normalizes: it returns a fresh copy and never the caller\'s object', () => {
  const input = JSON.parse(JSON.stringify(packs.toFile(themeById('beebo.light'))))
  const r = packs.validatePack(input)
  assert.notEqual(r.pack.content, input.content)
  input.content.vars['--bg'] = '#123456'
  assert.notEqual(r.pack.content.vars['--bg'], '#123456')
  assert.equal(packs.validatePack(input, { expectKind: 'layout' }).ok, false, 'wrong kind is refused when the caller expects one')
})

// ---- contrast checker and fixer --------------------------------------------------------------------------------

test('check() finds a failing pair and reports the ratio and what it is for', () => {
  const r = contrast.check('graphite', { '--text': '#3a3b40' })
  const f = r.failures.find((x) => x.fg === '--text' && x.bg === '--bg')
  assert.ok(f, 'text on the page fails')
  assert.ok(f.ratio < 4.5)
  assert.equal(f.min, 4.5)
  assert.match(f.what, /body text/)
})

test('autoFix() repairs low-contrast text without touching backgrounds, keeping the hue family', () => {
  const bad = { '--text': '#4a4b52', '--muted': '#555660', '--link': '#3a3f60' }
  const before = contrast.check('graphite', bad)
  assert.ok(before.failures.length >= 3)
  const fix = contrast.autoFix('graphite', bad)
  assert.deepEqual(fix.remaining, [])
  assert.deepEqual(contrast.check('graphite', fix.vars).failures, [])
  assert.ok(fix.changes.length >= 3)
  for (const c of fix.changes) assert.match(c.to, /^#[0-9a-f]{6}$/)
  for (const bg of ['--bg', '--panel', '--card-bg', '--sidebar-bg']) assert.ok(!fix.changes.some((c) => c.name === bg), bg + ' is never changed')
  const link = fix.changes.find((c) => c.name === '--link')
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(link.to.slice(i, i + 2), 16))
  assert.ok(b >= r, 'a blue-ish link stays blue-ish')
  void g
})

test('autoFix() is a no-op on a passing theme and reports what it cannot fix', () => {
  const ok = contrast.autoFix('daylight', {})
  assert.deepEqual(ok.changes, [])
  assert.deepEqual(ok.remaining, [])
  // a sidebar background that runs from black to white cannot carry any single link color at 4.5:1
  const impossible = contrast.autoFix('graphite', { '--sidebar-bg': 'linear-gradient(165deg,#000000,#ffffff)' })
  assert.ok(impossible.remaining.some((f) => f.bg === '--sidebar-bg'))
})

test('previewThemePack: warnings + a fix that fully resolves them, or fixable:false', () => {
  const p = JSON.parse(JSON.stringify(themeById('beebo.dark')))
  p.content.vars['--text'] = '#44454a'
  p.content.vars['--muted'] = '#4a4b52'
  const pre = packs.previewThemePack(p)
  assert.ok(pre.warnings.length >= 2)
  assert.equal(pre.fixable, true)
  assert.ok(pre.fixes.length >= 2)
  const fixed = packs.themeVarsFor(p, { autoFix: true })
  assert.deepEqual(contrast.check(packs.baseOf(p), fixed).failures, [])
  assert.deepEqual(packs.themeVarsFor(p, { autoFix: false }), p.content.vars, 'without the fix the pack is stored as designed')
})
