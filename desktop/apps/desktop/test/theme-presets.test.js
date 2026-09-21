'use strict'
// Presets: every non-default preset defines every variable, values are valid for their type, and the
// pairs that carry text are accessible. Also: applying a preset produces the right CSS and attribute.
const test = require('node:test')
const assert = require('node:assert/strict')
const theme = require('../electron/theme')
const { TOKENS, PRESETS, PRESET_IDS } = theme

const NON_DEFAULT = PRESET_IDS.filter((id) => PRESETS[id].vars)

function colorsIn(value) {
  return (String(value).match(/#[0-9a-f]{3,8}\b/gi) || []).map((c) => (c.length === 9 ? c.slice(0, 7) : c))
}
function varOf(id, name) {
  const preset = PRESETS[id]
  if (preset.vars && name in preset.vars) return preset.vars[name]
  return TOKENS.find((t) => t.name === name).default
}

// [foreground variable, background variable, minimum ratio, what it is]
// 4.5 = WCAG AA body text; 3 = large text, icons and control boundaries. A gradient background must pass at every stop.
const PAIRS = [
  ['--text', '--bg', 4.5, 'body text on the page'],
  ['--text', '--panel', 4.5, 'text on panels'],
  ['--text', '--raised', 4.5, 'text on raised panels'],
  ['--muted', '--bg', 4.5, 'secondary text on the page'],
  ['--muted', '--panel', 4.5, 'secondary text on panels and phone chips'],
  ['--soft-text', '--bg', 4.5, 'search status and empty state'],
  ['--link', '--bg', 4.5, 'links on the page'],
  ['--link', '--panel', 4.5, 'links on panels'],
  ['--text', '--input-bg', 4.5, 'typed text in fields'],
  ['--placeholder', '--input-bg', 4.5, 'placeholder in fields'],
  ['--text', '--search-bg', 4.5, 'typed text in the search box'],
  ['--placeholder', '--search-bg', 4.5, 'placeholder in the search box'],
  ['--on-accent', '--accent-grad-1', 4.5, 'button text (start)'],
  ['--on-accent', '--accent-grad-2', 4.5, 'button text (end)'],
  ['--on-accent', '--nav-active-grad-1', 4.5, 'active nav text (start)'],
  ['--on-accent', '--nav-active-grad-2', 4.5, 'active nav text (end)'],
  ['--on-accent', '--tab-active-bg', 4.5, 'active tab text'],
  ['--on-accent', '--btn-secondary-bg', 4.5, 'secondary button text'],
  ['--on-gold', '--gold', 4.5, 'skip link text'],
  ['--text-strong', '--hover-bg', 4.5, 'hovered nav link / tab'],
  ['--tab-text', '--bg', 4.5, 'tabs on the page'],
  ['--tab-text', '--hover-bg', 4.5, 'tab hover'],
  ['--logout-text', '--bg', 4.5, 'log out link'],
  ['--text-strong', '--sidebar-bg', 4.5, 'wordmark on the sidebar'],
  ['--sidebar-link', '--sidebar-bg', 4.5, 'sidebar links'],
  ['--sidebar-link', '--hover-bg', 4.5, 'sidebar link hover'],
  ['--sidebar-label', '--sidebar-bg', 4.5, 'sidebar section labels'],
  ['--sidebar-brand-sub', '--sidebar-bg', 4.5, 'sidebar tagline'],
  ['--sidebar-foot', '--sidebar-bg', 4.5, 'sidebar footer'],
  ['--sidebar-foot-strong', '--sidebar-bg', 4.5, 'sidebar footer heading'],
  ['--sidebar-link', '--sheet-bg', 4.5, 'phone More sheet links'],
  ['--sidebar-label', '--sheet-bg', 4.5, 'phone More sheet labels'],
  ['--text', '--card-bg', 4.5, 'poster titles'],
  ['--muted', '--card-bg', 4.5, 'poster sub-titles'],
  ['--noposter-text', '--noposter-bg', 4.5, 'placeholder poster title'],
  ['--text', '--mobilebar-bg', 4.5, 'phone top bar heading'],
  ['--brand-eyebrow', '--mobilebar-bg', 4.5, 'phone top bar eyebrow'],
  ['--gold', '--round-btn-bg', 3, 'phone search icon'],
  ['--text-strong', '--menu-bg', 4.5, 'phone menu button'],
  ['--muted', '--bottomnav-bg', 4.5, 'phone bottom tab label'],
  ['--tab-selected-text', '--bottomnav-bg', 4.5, 'selected phone tab label'],
  ['--chip-active-text', '--chip-active-bg', 4.5, 'selected phone chip'],
  ['--muted', '--alphabet-bg', 4.5, 'A-Z index letters (unused: uses gold)'],
  ['--gold', '--alphabet-bg', 4.5, 'A-Z index letters'],
  ['--alphabet-disabled', '--alphabet-bg', 3, 'A-Z index letters with no titles'],
  ['--alpha-bar-text', '--alpha-bar-bg', 4.5, 'desktop A-Z letters'],
  ['--alpha-bar-off', '--alpha-bar-bg', 3, 'desktop A-Z letters with no titles'],
  ['--gold', '--bg', 3, 'focus ring on the page'],
  ['--gold', '--panel', 3, 'focus ring on panels'],
  ['--focus-ring', '--bg', 3, 'focus ring (as set)'],
  ['--control-border', '--bg', 3, 'field boundary'],
  ['--nav-active-edge', '--nav-active-grad-1', 1, 'active nav edge exists']
]

function pairsFor(id) {
  const rows = []
  for (const [fg, bg, min, what] of PAIRS) {
    const fgValue = varOf(id, fg) === 'var(--gold)' ? varOf(id, '--gold') : varOf(id, fg)
    for (const f of colorsIn(fgValue)) {
      for (const b of colorsIn(varOf(id, bg))) rows.push({ fg, bg, f, b, min, what })
    }
  }
  return rows
}

test('every non-default preset defines every variable that is not derived, with valid values', () => {
  assert.ok(NON_DEFAULT.length >= 3, 'at least three presets besides the default')
  for (const id of NON_DEFAULT) {
    for (const tok of TOKENS) {
      if (tok.derived) continue
      assert.ok(tok.name in PRESETS[id].vars, `${id} defines ${tok.name}`)
      const parsed = theme.parseValue(tok.type, PRESETS[id].vars[tok.name])
      assert.ok(parsed.ok, `${id} ${tok.name} = ${PRESETS[id].vars[tok.name]} is a valid ${tok.type}`)
    }
    for (const name of Object.keys(PRESETS[id].vars)) {
      assert.ok(TOKENS.some((t) => t.name === name), `${id} sets ${name}, which is not in the registry`)
    }
  }
})

test('preset metadata: ids are simple, labels exist, scheme is dark or light, default is midnight with no CSS', () => {
  assert.equal(theme.DEFAULT_THEME, 'midnight')
  assert.equal(PRESETS.midnight.vars, null)
  assert.equal(theme.presetCss('midnight'), '')
  for (const id of PRESET_IDS) {
    assert.match(id, /^[a-z]{3,20}$/)
    assert.ok(PRESETS[id].label && PRESETS[id].description)
    assert.ok(['dark', 'light'].includes(PRESETS[id].scheme))
    assert.match(PRESETS[id].themeColor, /^#[0-9a-f]{6}$/)
  }
  assert.ok(PRESET_IDS.some((id) => PRESETS[id].scheme === 'light'), 'a light preset exists')
  assert.ok(NON_DEFAULT.filter((id) => PRESETS[id].scheme === 'dark').length >= 2, 'a neutral dark and an alternate-accent dark exist')
})

test('color-scheme follows the preset in the generated CSS', () => {
  for (const id of NON_DEFAULT) {
    const css = theme.presetCss(id)
    assert.ok(css.startsWith(`:root[data-theme="${id}"]{color-scheme:${PRESETS[id].scheme};`), id)
    assert.ok(css.endsWith('}'))
    assert.ok(!css.includes('\n'))
  }
  assert.match(theme.presetCss('daylight'), /color-scheme:light/)
  assert.match(theme.presetCss('graphite'), /color-scheme:dark/)
})

test('a preset block carries exactly the preset values (preset-application)', () => {
  for (const id of NON_DEFAULT) {
    const css = theme.presetCss(id)
    for (const [name, value] of Object.entries(PRESETS[id].vars)) {
      assert.ok(css.includes(`${name}:${value};`), `${id} css includes ${name}`)
    }
    const declarations = css.slice(css.indexOf('{') + 1, -1).split(';').filter(Boolean).length
    assert.equal(declarations, Object.keys(PRESETS[id].vars).length + 1, 'values plus color-scheme')
  }
})

test('applying a theme sets the html attribute, theme-color and CSS for that preset only', () => {
  const dflt = theme.renderInfo({ theme: 'midnight', custom: {} })
  assert.deepEqual(dflt, { id: 'midnight', scheme: 'dark', themeColor: '#182033', css: '' })
  const light = theme.renderInfo({ theme: 'daylight', custom: {} })
  assert.equal(light.id, 'daylight')
  assert.equal(light.scheme, 'light')
  assert.equal(light.themeColor, PRESETS.daylight.themeColor)
  assert.equal(light.css, theme.presetCss('daylight'))
  assert.ok(!light.css.includes(':root[data-theme="ember"]'))
  // an id that is not a preset falls back to the default instead of reaching the page
  assert.equal(theme.renderInfo({ theme: '"><script>', custom: {} }).id, 'midnight')
  assert.equal(theme.renderInfo({ theme: '__proto__', custom: {} }).id, 'midnight')
  // safe mode ignores what is saved
  assert.deepEqual(theme.renderInfo({ theme: 'daylight', custom: { '--bg': '#000000' } }, { safe: true }), dflt)
})

test('custom overrides come after the preset in the same block order and win', () => {
  const info = theme.renderInfo({ theme: 'daylight', custom: { '--bg': '#ffffff', '--accent-grad-1': '#123456' } })
  assert.ok(info.css.indexOf(':root[data-theme="daylight"]') < info.css.indexOf(':root[data-theme]{'))
  assert.match(info.css, /:root\[data-theme\]\{--bg:#ffffff;--accent-grad-1:#123456;\}$/)
})

test('accessibility: text pairs in every non-default preset meet WCAG AA', () => {
  const failures = []
  for (const id of NON_DEFAULT) {
    for (const row of pairsFor(id)) {
      const ratio = theme.contrastRatio(row.f, row.b)
      if (ratio === null || ratio < row.min) {
        failures.push(`${id}: ${row.what} - ${row.fg} ${row.f} on ${row.bg} ${row.b} = ${ratio && ratio.toFixed(2)} (need ${row.min})`)
      }
    }
  }
  assert.deepEqual(failures, [])
})

test('accessibility: the light preset reaches AAA (7:1) for body text and links', () => {
  for (const [fg, bg] of [['--text', '--bg'], ['--text', '--panel'], ['--link', '--bg'], ['--muted', '--bg']]) {
    const ratio = theme.contrastRatio(varOf('daylight', fg), varOf('daylight', bg))
    assert.ok(ratio >= 7, `${fg} on ${bg} is ${ratio.toFixed(2)}`)
  }
})

test('contrast helper matches published WCAG values', () => {
  assert.equal(Math.round(theme.contrastRatio('#000000', '#ffffff') * 10) / 10, 21)
  assert.equal(theme.contrastRatio('#fff', '#fff'), 1)
  assert.ok(Math.abs(theme.contrastRatio('#777777', '#ffffff') - 4.48) < 0.02)
  assert.equal(theme.contrastRatio('red', '#fff'), null)
  assert.ok(theme.contrastRatio('rgb(0,0,0)', 'hsl(0,0%,100%)') > 20.9)
})
