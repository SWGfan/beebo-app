'use strict'
// The "Custom" theme slot is the one place a person types something that ends up inside the site's
// stylesheet. These tests are the wall: only `--variable: value;` lines from the allowlist, with safe
// values, ever produce CSS, and the CSS is rebuilt by the server from parsed pairs.
const test = require('node:test')
const assert = require('node:assert/strict')
const theme = require('../electron/theme')

const parse = theme.parseCustomTheme
const ok = (text) => { const r = parse(text); assert.equal(r.ok, true, `expected ok for ${JSON.stringify(text)}: ${JSON.stringify(r.errors)}`); return r.pairs }
const bad = (text, why) => {
  const r = parse(text)
  assert.equal(r.ok, false, `expected rejection${why ? ' (' + why + ')' : ''} for ${JSON.stringify(String(text).slice(0, 120))}`)
  assert.deepEqual(r.pairs, {}, 'a rejected input applies nothing')
  assert.ok(r.errors.length >= 1 && r.errors.length <= 20, 'gives at least one and a bounded number of messages')
  return r
}

// Everything the server can emit for a custom theme must fit this: registry names, and values built only
// from hex digits, letters, digits, % . , ( ) - and spaces.
const CSS_SHAPE = /^:root\[data-theme\]\{(?:--[a-z0-9-]+:[#a-z0-9%.,()\s-]+;)+\}$/
const NEVER_IN_CSS = [/url\s*\(/i, /expression/i, /@import/i, /javascript/i, /\\/, /\/\*/, /</, />/, /"/, /'/, /[{}](?!$)/]
function assertSafeCss(css) {
  if (css === '') return
  assert.match(css, CSS_SHAPE)
  const inner = css.slice(css.indexOf('{') + 1, -1)
  assert.ok(!/[{}]/.test(inner), 'no braces inside the block')
  for (const re of NEVER_IN_CSS.slice(0, -1)) assert.ok(!re.test(css), `css must not match ${re}`)
  for (const decl of inner.split(';').filter(Boolean)) assert.ok(theme.TOKENS.some((t) => decl.startsWith(t.name + ':')), `declaration ${decl} uses a registry name`)
}

// ---------------------------------------------------------------- accepted input ----------------------

test('accepts allowlisted variables with hex, rgb(), hsl() and transparent colors', () => {
  assert.deepEqual(ok('--bg: #101418;'), { '--bg': '#101418' })
  assert.deepEqual(ok('--bg:#abc;--text:#ABCDEF;--muted:#12345678'), { '--bg': '#abc', '--text': '#abcdef', '--muted': '#12345678' })
  assert.deepEqual(ok('--panel: rgb( 16 , 24 , 32 );'), { '--panel': 'rgb(16,24,32)' })
  assert.deepEqual(ok('--panel: rgba(16,24,32,0.5);'), { '--panel': 'rgba(16,24,32,0.5)' })
  assert.deepEqual(ok('--panel: rgba(16,24,32,50%);'), { '--panel': 'rgba(16,24,32,0.5)' })
  assert.deepEqual(ok('--panel: rgba(16,24,32,.25);'), { '--panel': 'rgba(16,24,32,0.25)' })
  assert.deepEqual(ok('--line: hsl(210, 40%, 20%);'), { '--line': 'hsl(210,40%,20%)' })
  assert.deepEqual(ok('--line: hsla(210deg,40%,20%,0.8);'), { '--line': 'hsla(210,40%,20%,0.8)' })
  assert.deepEqual(ok('--empty-bg: transparent;'), { '--empty-bg': 'transparent' })
  assert.deepEqual(ok('--gold: TRANSPARENT;'), { '--gold': 'transparent' })
})

test('accepts gradients where the variable takes a paint, and none for a layer', () => {
  assert.deepEqual(ok('--sidebar-bg: linear-gradient(165deg, #14294a, #0c1428 48%, #090b14);'), { '--sidebar-bg': 'linear-gradient(165deg,#14294a,#0c1428 48%,#090b14)' })
  assert.deepEqual(ok('--sidebar-bg: linear-gradient(to bottom right, rgb(1,2,3), hsl(0,0%,50%));'), { '--sidebar-bg': 'linear-gradient(to bottom right,rgb(1,2,3),hsl(0,0%,50%))' })
  assert.deepEqual(ok('--sidebar-bg: linear-gradient(#000, #fff);'), { '--sidebar-bg': 'linear-gradient(#000,#fff)' })
  assert.deepEqual(ok('--card-bg: radial-gradient(ellipse at 85% 0, #354b76, transparent 65%);'), { '--card-bg': 'radial-gradient(ellipse at 85% 0,#354b76,transparent 65%)' })
  assert.deepEqual(ok('--card-bg: radial-gradient(circle, #fff 0, #000 100%);'), { '--card-bg': 'radial-gradient(circle,#fff 0,#000 100%)' })
  assert.deepEqual(ok('--sidebar-bg: #0c1428;'), { '--sidebar-bg': '#0c1428' }, 'a paint may be a plain color')
  assert.deepEqual(ok('--noposter-bg: radial-gradient(#fff, #000), linear-gradient(145deg,#111,#222);'), { '--noposter-bg': 'radial-gradient(#fff,#000),linear-gradient(145deg,#111,#222)' })
  assert.deepEqual(ok('--noposter-bg: linear-gradient(#111,#222), #333;'), { '--noposter-bg': 'linear-gradient(#111,#222),#333' }, 'a color may be the last layer')
  assert.deepEqual(ok('--page-glow: none;'), { '--page-glow': 'none' })
  assert.deepEqual(ok('--page-glow: radial-gradient(ellipse at 100% 0, #162d4d 0, transparent 50%);'), { '--page-glow': 'radial-gradient(ellipse at 100% 0,#162d4d 0,transparent 50%)' })
})

test('accepts capped sizes for the radius variables', () => {
  assert.deepEqual(ok('--radius-card: 0;'), { '--radius-card': '0px' })
  assert.deepEqual(ok('--radius-card: 16px; --radius-control: 0.5rem; --radius-button: 999em'.replace('999em', '1.5em')), { '--radius-card': '16px', '--radius-control': '0.5rem', '--radius-button': '1.5em' })
  assert.deepEqual(ok('--radius-card: 64px;'), { '--radius-card': '64px' })
})

test('whitespace, newlines, CRLF and a missing final semicolon are fine; empty input is a no-op', () => {
  assert.deepEqual(ok('  --bg : #111 ;\r\n\t--text:\n#eee\r\n;\n'), { '--bg': '#111', '--text': '#eee' })
  assert.deepEqual(ok('--bg:#111'), { '--bg': '#111' })
  for (const empty of ['', '   ', '\n\n', undefined, null]) assert.deepEqual(parse(empty), { ok: true, pairs: {}, errors: [] })
})

test('every registry variable accepts its own default (except those that follow another variable)', () => {
  for (const tok of theme.TOKENS) {
    if (tok.derived) {
      assert.equal(parse(`${tok.name}:${tok.default};`).ok, false, `${tok.name} default is a var() reference, not accepted from a person`)
      continue
    }
    const pairs = ok(`${tok.name}: ${tok.default};`)
    assert.equal(pairs[tok.name], tok.default, `${tok.name} round-trips`)
  }
})

test('output is canonical: parsing the rendered text again changes nothing', () => {
  const pairs = ok('--BG:#fff;'.toLowerCase() + '--text: #ABC ; --sidebar-bg: linear-gradient( 90deg , RGB(1, 2, 3) , #FFF 50% );')
  const again = ok(theme.customText(pairs))
  assert.deepEqual(again, pairs)
})

// ---------------------------------------------------------------- CSS injection -----------------------

test('rejects breaking out of the declaration: closing braces, new rules, extra properties', () => {
  bad('--bg: red;}body{display:none')
  bad('--bg: #fff;}body{display:none')
  bad('--bg: #fff;}body{display:none}')
  bad('--bg: #fff;} body { display: none } :root { --text: #000')
  bad('--bg: #fff}\nbody{display:none}\n:root{--x:#000;')
  bad(':root{--bg:#fff}')
  bad('{--bg:#fff}')
  bad('--bg:#fff;}')
  bad('}--bg:#fff;')
  bad('--bg: #fff; } @media all { body { display:none')
  bad('--bg: #fff; display: none;')
  bad('display: none;')
  bad('body { color: red }')
  bad('--bg: #fff; background: url(x);')
})

test('rejects url(), image functions and script schemes however they are spelled', () => {
  for (const text of [
    '--bg: url(javascript:alert(1));',
    '--bg: url("javascript:alert(1)");',
    "--bg: url('https://evil.example/x.png');",
    '--bg: URL(http://evil.example/x);',
    '--bg: uRl(x);',
    '--bg: url (x);',
    '--bg: url\n(x);',
    '--card-bg: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=);',
    '--card-bg: linear-gradient(#fff, url(x));',
    '--card-bg: image-set("a.png" 1x);',
    '--card-bg: -webkit-image-set(url(a.png) 1x);',
    '--card-bg: image(#fff);',
    '--card-bg: src(x);',
    '--card-bg: element(#a);',
    '--card-bg: paint(worklet);',
    '--bg: javascript:alert(1);',
    '--bg: vbscript:msgbox(1);',
    '--bg: data:text/html,<script>alert(1)</script>;',
    '--bg: expression(alert(1));',
    '--bg: EXPRESSION(alert(1));',
    '--bg: #fff; behavior: url(x.htc);',
    '--bg: -moz-binding: url(x);'
  ]) bad(text)
})

test('rejects CSS escape sequences (\\75rl( and friends)', () => {
  for (const text of [
    '--bg: \\75rl(x);',
    '--bg: \\000075rl(x);',
    '--bg: \\75 rl(x);',
    '--bg: u\\rl(x);',
    '--bg: ur\\6c(x);',
    '--bg: #fff\\;',
    '--bg: #fff\\',
    '--b\\67: #fff;',
    '--bg: \\',
    '--bg: "\\"";',
    '--bg: #\\66ff;'
  ]) bad(text, 'backslash')
})

test('rejects comments, at-rules, imports, quotes, !important, angle brackets and HTML', () => {
  for (const text of [
    '--bg: #fff /* hi */;',
    '/* hi */ --bg: #fff;',
    '--bg: #fff; /*',
    '--bg: #fff; */',
    '--bg: /**/#fff;',
    '--bg: #fff; // note',
    '@import url(x);',
    '@import "x.css";',
    "@import 'x.css';",
    '--bg: #fff; @import x;',
    '@charset "utf-8";',
    '@font-face { font-family: x }',
    '--bg: "#fff";',
    "--bg: '#fff';",
    '--bg: `#fff`;',
    '--bg: #fff !important;',
    '--bg: !important #fff;',
    '--bg: #fff!important;',
    '--bg: #fff></style><script>alert(1)</script>;',
    '</style><script>alert(1)</script>',
    '--bg: <style>;',
    '<!-- --bg: #fff; -->',
    '--bg: #fff&#59;',
    '--bg: #fff&amp;'
  ]) bad(text)
})

test('rejects var(), calc(), env(), attr() and other functions the grammar does not include', () => {
  for (const text of [
    '--bg: var(--text);',
    '--bg: var(--text, red);',
    '--focus-ring: var(--gold);',
    '--radius-card: calc(1px + 2px);',
    '--radius-card: min(4px, 1rem);',
    '--radius-card: max(4px, 1rem);',
    '--radius-card: clamp(1px, 2px, 3px);',
    '--bg: env(safe-area-inset-top);',
    '--bg: attr(data-x);',
    '--bg: color-mix(in srgb, red, blue);',
    '--bg: rgb(from red r g b);',
    '--bg: light-dark(#fff, #000);',
    '--bg: lab(50% 40 59.5);',
    '--bg: currentcolor;',
    '--bg: inherit;',
    '--bg: initial;',
    '--bg: unset;',
    '--bg: revert;',
    '--bg: red;',
    '--bg: Red;',
    '--bg: white;',
    '--bg: #fff #000;',
    '--bg: #fff, #000;',
    '--bg: #fff : #000;'
  ]) bad(text)
})

// ---------------------------------------------------------------- semicolon / structure ---------------

test('rejects semicolon injection and malformed structure', () => {
  for (const text of [
    '--bg: #fff;;',
    ';--bg: #fff;',
    ';;;',
    ';',
    '--bg: #fff; ; --text: #000;',
    '--bg: #fff;\n;\n--text:#000',
    '--bg',
    '--bg:',
    '--bg: ;',
    ': #fff;',
    '--: #fff;',
    '-- bg: #fff;',
    '--bg #fff;',
    '--bg = #fff;',
    '--bg:: #fff;',
    '--bg: #fff:#000;',
    '#fff;',
    '--bg: #fff; --text',
    '--bg:#fff;--bg:#000;',
    '--bg: #fff\n--text: #000;'
  ]) bad(text)
})

test('rejects variables that are not on the allowlist, in any casing or spelling', () => {
  for (const text of [
    '--evil: #fff;',
    '--BG: #fff;',
    '--Bg: #fff;',
    '--bg2: #fff;',
    '--bg-: #fff;',
    '--_bg: #fff;',
    '--constructor: #fff;',
    '--__proto__: #fff;',
    '--proto: #fff;',
    '--toString: #fff;',
    '--hasOwnProperty: #fff;',
    'color: #fff;',
    'background: #fff;',
    'background-image: url(x);',
    '-webkit-text-fill-color: #fff;',
    '--webkit-x: #fff;',
    '--' + 'a'.repeat(500) + ': #fff;',
    '--<script>: #fff;',
    '--bg : #fff;'
  ]) bad(text)
  const r = parse('--<script>alert(1)</script>: #fff;')
  assert.ok(!r.errors.join(' ').includes('<'), 'a hostile name is never echoed back in messages')
  const r2 = parse('--' + 'x'.repeat(30) + ': #fff;')
  assert.ok(r2.errors.some((e) => e.includes('--' + 'x'.repeat(30))), 'a plausible unknown name is echoed so the person can fix it')
})

// ---------------------------------------------------------------- unicode tricks ---------------------

test('rejects anything outside plain printable ASCII: look-alikes, invisible and control characters', () => {
  for (const text of [
    '--bg: #ｆff;', // fullwidth f
    '--bg: ｕrl(x);', // fullwidth u
    '--bg: urı(x);', // dotless i
    '--bg: #fff​;', // zero width space
    '--bg: #fff‍;', // zero width joiner
    '--bg: #fff;', // no-break space
    '--bg: #fff --text: #000;', // line separator
    '--bg: #fff ', // paragraph separator
    '--bg: #fff;‮', // right-to-left override
    '﻿--bg: #fff;', // BOM
    '--bg: #fff ;', // NUL
    '--bg: #fff;', // bell
    '--bg: #fff;', // DEL
    '--bg: #fff[0m;', // escape
    '--bg: #fff\v;', // vertical tab
    '--bg: #fff\f;', // form feed
    '--bg: #fff;；--text:#000;', // fullwidth semicolon
    '--bg： #fff;', // fullwidth colon
    '--bg: ＃fff;', // fullwidth number sign
    '--bg: #fff 😀;', // emoji
    '--bг: #fff;', // cyrillic g
    '--бg: #fff;', // cyrillic b
    '--bg: еxpression(x);', // cyrillic e
    '--bg: #ffƒ;' // f with hook
  ]) bad(text, 'non-ASCII')
})

// ---------------------------------------------------------------- values that are close to valid -----

test('rejects malformed and out-of-range colors', () => {
  for (const value of [
    '#', '#f', '#ff', '#fffff', '#fffffff', '#fffffffff', '#ggg', '#12345g', '# fff', '##fff', 'fff', '0xfff',
    'rgb(300,0,0)', 'rgb(0,0,256)', 'rgb(-1,0,0)', 'rgb(1,2)', 'rgb(1,2,3,4,5)', 'rgb(1 2 3)', 'rgb(1,2,3', 'rgb(1,2,3))', 'rgb()', 'rgb(a,b,c)',
    'rgba(1,2,3,2)', 'rgba(1,2,3,1.5)', 'rgba(1,2,3,-0.5)', 'rgba(1,2,3,101%)', 'rgba(1,2,3,.)', 'rgba(1,2,3,1e3)',
    'hsl(400,10%,10%)', 'hsl(10,101%,10%)', 'hsl(10,10%,101%)', 'hsl(10,10,10)', 'hsl(10%,10%,10%)', 'hsl(-10,10%,10%)',
    'rgb(1,2,3);', 'rgb(1,2,3)}', 'RGB(1,2,3) RGB(4,5,6)', 'rgb(rgb(1,2,3),2,3)', 'rgb(1,2,3)rgb(4,5,6)'
  ]) bad(`--bg: ${value};`, value)
})

test('rejects a gradient or plain color where the variable does not take one, and malformed gradients', () => {
  bad('--bg: linear-gradient(#fff, #000);', 'color variable, gradient given')
  bad('--text: none;', 'none is not a color')
  bad('--page-glow: #fff;', 'a layer must be a gradient or none (a bare color is invalid above another background)')
  bad('--page-glow: linear-gradient(#000,#111), #fff;')
  bad('--noposter-bg: #fff, linear-gradient(#000,#111);', 'a color may only be the final layer')
  bad('--sidebar-bg: linear-gradient(#fff);', 'one stop')
  bad('--sidebar-bg: linear-gradient();')
  bad('--sidebar-bg: linear-gradient(90deg);')
  bad('--sidebar-bg: linear-gradient(90deg, #fff);')
  bad('--sidebar-bg: linear-gradient(#fff,);')
  bad('--sidebar-bg: linear-gradient(,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(#fff,,#000);')
  bad('--sidebar-bg: linear-gradient(#fff,#000;')
  bad('--sidebar-bg: linear-gradient(#fff,#000));')
  bad('--sidebar-bg: linear-gradient(#fff,#000)linear-gradient(#111,#222);')
  bad('--sidebar-bg: linear-gradient(361deg,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(-90deg,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(90turn,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(to top bottom,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(to top top,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(to,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(to middle,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(90deg,#fff 101%,#000);')
  bad('--sidebar-bg: linear-gradient(90deg,#fff 5000px,#000);')
  bad('--sidebar-bg: linear-gradient(90deg,#fff 10em,#000);')
  bad('--sidebar-bg: linear-gradient(90deg,#fff -5%,#000);')
  bad('--sidebar-bg: linear-gradient(90deg,#fff 10% 20%,#000);', 'two positions')
  bad('--sidebar-bg: linear-gradient(90deg,red,blue);', 'named colors')
  bad('--sidebar-bg: linear-gradient(90deg,#fff,#000,#111,#222,#333,#444,#555,#666,#777);', 'nine stops')
  bad('--sidebar-bg: repeating-linear-gradient(#fff,#000);')
  bad('--sidebar-bg: conic-gradient(#fff,#000);')
  bad('--sidebar-bg: -webkit-linear-gradient(#fff,#000);')
  bad('--sidebar-bg: linear-gradient(in oklab,#fff,#000);')
  bad('--sidebar-bg: linear-gradient(#fff,#000), linear-gradient(#fff,#000), linear-gradient(#fff,#000), linear-gradient(#fff,#000);', 'four layers')
  bad('--sidebar-bg: radial-gradient(ellipse at 101% 0,#fff,#000);')
  bad('--sidebar-bg: radial-gradient(ellipse at 10% ,#fff,#000);')
  bad('--sidebar-bg: radial-gradient(ellipse at 10% 10% 10%,#fff,#000);')
  bad('--sidebar-bg: radial-gradient(ellipse at center-ish 0,#fff,#000);')
  bad('--sidebar-bg: radial-gradient(farthest-corner,#fff,#000);')
  bad('--sidebar-bg: radial-gradient(ellipse at 1px 1px,#fff,#000);', 'px positions are not accepted for the radial center')
  bad('--sidebar-bg: linear-gradient(rgb(rgb(1,2,3),4,5),#000);', 'nested functions')
  bad('--sidebar-bg: linear-gradient(linear-gradient(#fff,#000),#000);')
  bad('--sidebar-bg: linear-gradient(#fff,#000)x;')
  bad('--sidebar-bg: xlinear-gradient(#fff,#000);')
})

test('rejects sizes that are unitless, negative, huge, or not a plain length', () => {
  for (const value of ['12', '-4px', '65px', '4.01em', '5rem', '100px', '1e2px', '1.234px', '12 px', '12pt', '12vh', '50%', '12px 4px', 'auto', 'calc(1px)', '+4px', '4px;', '0x4px', '.5px', '999999px']) {
    bad(`--radius-card: ${value};`, value)
  }
})

// ---------------------------------------------------------------- size and performance ---------------

test('rejects input over the length cap outright, without scanning it', () => {
  const start = process.hrtime.bigint()
  bad('a'.repeat(theme.LIMITS.maxTextLength + 1))
  bad('--bg: #fff;\n'.repeat(1000))
  bad('x'.repeat(5_000_000))
  bad(' '.repeat(theme.LIMITS.maxTextLength + 1) + '--bg:#fff;')
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  assert.ok(ms < 250, `over-cap input is refused quickly (${ms.toFixed(1)}ms)`)
  // exactly at the cap is judged on its content, not its length
  const atCap = '--bg:#fff;'.padEnd(theme.LIMITS.maxTextLength, ' ')
  assert.equal(atCap.length, theme.LIMITS.maxTextLength)
  assert.deepEqual(ok(atCap), { '--bg': '#fff' })
})

test('caps one value, the number of declarations and the stops in a gradient', () => {
  bad(`--sidebar-bg: linear-gradient(${Array.from({ length: 60 }, (_, i) => '#' + (100 + i)).join(',')});`, 'too many stops')
  bad('--sidebar-bg: ' + 'linear-gradient(#fff,#000),'.repeat(20) + '#000;', 'value too long')
  bad(`--bg: #${'f'.repeat(400)};`, 'value over the cap')
  const many = theme.TOKENS.map((t) => `${t.name}:#fff;`).join('') + '--bg:#000;'
  bad(many, 'more declarations than variables')
})

test('hostile input cannot make the parser slow (no catastrophic backtracking, deep nesting, long runs)', () => {
  const nasty = [
    '--bg: ' + '('.repeat(3000) + ';',
    '--bg: rgb(' + ' '.repeat(3000) + ');',
    '--bg: rgb(' + '1,'.repeat(1500) + ');',
    '--sidebar-bg: linear-gradient(' + '#fff 1%,'.repeat(400) + '#000);',
    '--sidebar-bg: linear-gradient(' + '('.repeat(1500) + ');',
    '--sidebar-bg: radial-gradient(ellipse' + ' at'.repeat(1000) + ',#fff,#000);',
    '--bg: ' + '#' + 'f'.repeat(3000) + ';',
    '--bg: ' + 'a'.repeat(3500) + ' ' + 'a'.repeat(400),
    ('--bg:' + ' '.repeat(100) + ';').repeat(30),
    '--radius-card: ' + '1'.repeat(3000) + ';',
    '--bg: hsl(' + '1'.repeat(3000) + ');'
  ]
  const start = process.hrtime.bigint()
  for (const text of nasty) assert.equal(parse(text).ok, false)
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  assert.ok(ms < 500, `all hostile inputs are handled in ${ms.toFixed(1)}ms`)
})

test('non-string input is refused', () => {
  for (const value of [42, true, {}, [], ['--bg:#fff;'], { toString: () => '--bg:#fff;' }, Symbol.iterator && 1n]) {
    assert.equal(parse(value).ok, false)
  }
})

// ---------------------------------------------------------------- the CSS that reaches the page -------

test('the server builds the stylesheet from validated pairs only, in registry order', () => {
  const pairs = ok('--text: #ffffff; --bg: #101418; --sidebar-bg: linear-gradient(165deg,#14294a,#0c1428 48%,#090b14);')
  const css = theme.customCss(pairs)
  assert.equal(css, ':root[data-theme]{--bg:#101418;--text:#ffffff;--sidebar-bg:linear-gradient(165deg,#14294a,#0c1428 48%,#090b14);}')
  assertSafeCss(css)
  assert.equal(theme.customCss({}), '')
  assert.equal(theme.customCss(null), '')
  assert.equal(theme.customCss(undefined), '')
})

test('even a tampered store cannot inject: customCss re-validates every stored pair', () => {
  const tampered = {
    '--bg': 'red;}body{display:none',
    '--text': '#fff;}html{display:none}',
    '--muted': 'url(javascript:alert(1))',
    '--line': '\\75rl(x)',
    '--evil': '#fff',
    '__proto__': '#fff',
    'constructor': '#fff',
    '--link': '#c5afff',
    '--gold': { toString() { return '#fff' } },
    '--panel': ['#fff'],
    '--raised': 42,
    '--purple': null
  }
  const css = theme.customCss(tampered)
  assert.equal(css, ':root[data-theme]{--link:#c5afff;}')
  assertSafeCss(css)
  assert.deepEqual(theme.sanitizePairs(tampered), { '--link': '#c5afff' })
  assert.equal(theme.customCss({ '--bg': 'red;}body{display:none' }), '')
  assert.equal(theme.customCss('--bg:#fff;'), '', 'a string is not a pairs object')
  assert.equal(theme.customCss(['--bg']), '')
})

test('fuzz: random combinations of hostile fragments never yield unsafe CSS', () => {
  let seed = 0x2545f491
  const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x100000000 }
  const names = theme.TOKENS.map((t) => t.name)
  const fragments = [
    ...names, '--bg', '--evil', ':', ';', ' ', '\n', '{', '}', '(', ')', ',', '%', '.', '#', '#fff', '#12345678', 'rgb(1,2,3)', 'hsl(1,2%,3%)',
    'linear-gradient(#fff,#000)', 'radial-gradient(ellipse at 1% 2%,#fff,#000)', 'none', 'transparent', '12px', '0', 'url(x)', 'url(', '\\', '\\75', '/*', '*/',
    '@import', '<', '>', '"', "'", '!important', 'expression(', 'javascript:', ' ', 'ｕ', '‮', 'red', 'var(--bg)', 'calc(1px)', ';}body{display:none;'
  ]
  let accepted = 0
  for (let i = 0; i < 4000; i++) {
    const n = 1 + Math.floor(rand() * 12)
    let text = ''
    for (let j = 0; j < n; j++) text += fragments[Math.floor(rand() * fragments.length)] + (rand() < 0.3 ? ' ' : '')
    const result = parse(text)
    if (!result.ok) { assert.deepEqual(result.pairs, {}); continue }
    accepted++
    assertSafeCss(theme.customCss(result.pairs))
    assert.deepEqual(parse(theme.customText(result.pairs)).pairs, result.pairs, 'accepted text round-trips')
  }
  // structured fuzz: valid-looking declarations with one hostile splice must never be accepted with the hostile part intact
  for (let i = 0; i < 2000; i++) {
    const name = names[Math.floor(rand() * names.length)]
    const hostile = fragments[Math.floor(rand() * fragments.length)]
    const text = `${name}: #123456${hostile}; --text: #fefefe;`
    const result = parse(text)
    if (result.ok) assertSafeCss(theme.customCss(result.pairs))
  }
  assert.ok(accepted >= 0)
})

test('the readability guard refuses text and background that collide, and allows sensible overrides', () => {
  assert.equal(theme.readabilityProblems('midnight', {}).length, 0)
  assert.equal(theme.readabilityProblems('daylight', {}).length, 0)
  assert.ok(theme.readabilityProblems('midnight', { '--text': '#080b14' }).length >= 1, 'text equal to the page background')
  assert.ok(theme.readabilityProblems('midnight', { '--bg': '#f2f3ff' }).length >= 1)
  assert.ok(theme.readabilityProblems('daylight', { '--bg': '#101418' }).length >= 1, 'a light preset with a dark page')
  assert.equal(theme.readabilityProblems('midnight', { '--bg': '#000000', '--text': '#ffffff' }).length, 0)
  assert.equal(theme.readabilityProblems('midnight', { '--bg': 'rgba(0,0,0,0.5)' }).length, 0, 'a translucent value is not judged')
  assert.equal(theme.readabilityProblems('midnight', { '--accent-grad-1': '#ffffff' }).length, 0, 'variables outside the guarded pairs are free')
})
