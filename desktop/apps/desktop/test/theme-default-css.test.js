'use strict'
// Zero visual regression: the tokenized stylesheet's DEFAULT theme (midnight) must resolve to exactly the
// colors, gradients and sizes browserTheme.css had before theming existed.
//
// test/fixtures/browserTheme.pre-theming.css is the stylesheet as it was, byte for byte. Here every
// `var(--token)` the tokenization introduced is replaced by the token's default from the new :root block;
// the result must equal the old file. The old file used literal hex where the phone layout meant "the phone
// core palette" (its own :root override), and the new one says var(--muted) etc. there, so inside that one
// media block the legacy core variables are resolved with the phone override in BOTH files before comparing.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const theme = require('../electron/theme')
const browserChrome = require('../electron/browserChrome')

const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n')
const before = read('fixtures', 'browserTheme.pre-theming.css')
const after = read('..', 'electron', 'browserTheme.css')

const LEGACY = ['--bg', '--panel', '--raised', '--text', '--muted', '--line', '--purple', '--gold', '--link']

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, '') }

/** The first `:root{...}` rule: its text span and its declarations. */
function rootRule(css, from = 0) {
  const start = css.indexOf(':root{', from)
  assert.ok(start >= 0, ':root rule exists')
  const end = css.indexOf('}', start)
  const decls = new Map()
  for (const d of stripComments(css.slice(start + 6, end)).split(';')) {
    const i = d.indexOf(':')
    if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim())
  }
  return { start, end: end + 1, decls }
}

/** Substring of the media block that starts at `marker`, brace matched. */
function block(css, marker) {
  const start = css.indexOf(marker)
  assert.ok(start >= 0, `${marker} exists`)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return { start, end: i + 1 }
  }
  throw new Error('unbalanced block')
}

const PHONE_MARKER = '@media(max-width:860px){\n  :root{'

function withoutHooks(css) { return css.replace(/\/\* theme-hooks-begin[\s\S]*?\/\* theme-hooks-end \*\/\n?/, '') }

function expand(css, tokenDefaults, phoneLegacy) {
  css = withoutHooks(css)
  const withoutRoot = (() => { const r = rootRule(css); return css.slice(0, r.start) + css.slice(r.end) })()
  let text = stripComments(withoutRoot)
  // tokens can reference other tokens (only --focus-ring / --nav-active-edge, which reference legacy vars)
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/var\((--[a-z0-9-]+)\)/g, (whole, name) => (tokenDefaults.has(name) ? tokenDefaults.get(name) : whole))
  }
  const phone = block(text, PHONE_MARKER)
  const inPhone = text.slice(phone.start, phone.end).replace(/var\((--[a-z0-9-]+)\)/g, (whole, name) => (phoneLegacy.has(name) ? phoneLegacy.get(name) : whole))
  return text.slice(0, phone.start) + inPhone + text.slice(phone.end)
}

const beforeRoot = rootRule(before)
const afterRoot = rootRule(after)
const hooks = /\/\* theme-hooks-begin[\s\S]*?\/\* theme-hooks-end \*\//.exec(after)
const phoneOverride = rootRule(before, before.indexOf(PHONE_MARKER))
const phoneLegacy = new Map([...beforeRoot.decls].filter(([k]) => LEGACY.includes(k)))
for (const [k, v] of phoneOverride.decls) phoneLegacy.set(k, v)

test('the :root block in browserTheme.css equals the token registry defaults, in order', () => {
  const fromCss = [...afterRoot.decls].filter(([k]) => k !== 'color-scheme').map(([k, v]) => `${k}:${v}`)
  const fromRegistry = theme.TOKENS.map((t) => `${t.name}:${t.default}`)
  assert.deepEqual(fromCss, fromRegistry)
  assert.equal(afterRoot.decls.get('color-scheme'), 'dark')
})

test('the original core palette values are unchanged', () => {
  for (const name of LEGACY) assert.equal(afterRoot.decls.get(name), beforeRoot.decls.get(name), name)
})

test('the phone :root override still swaps only the original core variables', () => {
  const afterPhone = rootRule(after, after.indexOf(PHONE_MARKER))
  assert.deepEqual([...afterPhone.decls], [...phoneOverride.decls])
  for (const name of afterPhone.decls.keys()) assert.ok(LEGACY.includes(name), `${name} is a core variable`)
})

test('default theme output: every token expanded to its default reproduces the pre-theming stylesheet exactly', () => {
  // only the tokens theming introduced: the original core variables stay var() references in both files
  const defaults = new Map(theme.TOKENS.filter((t) => !LEGACY.includes(t.name)).map((t) => [t.name, t.default]))
  const expandedAfter = expand(after, defaults, phoneLegacy)
  const expandedBefore = expand(before, new Map(), phoneLegacy)
  // compare rule by rule first so a mismatch names the rule
  const rules = (css) => css.split('\n').map((l) => l.trim()).filter(Boolean)
  const a = rules(expandedAfter)
  const b = rules(expandedBefore)
  assert.equal(a.length, b.length, 'same number of stylesheet lines')
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      let at = 0
      while (a[i][at] === b[i][at]) at++
      assert.fail(`line ${i + 1} differs near: ...${a[i].slice(Math.max(0, at - 60), at + 60)}\n  was: ...${b[i].slice(Math.max(0, at - 60), at + 60)}`)
    }
  }
  assert.equal(expandedAfter, expandedBefore)
})

test('new tokens are only overridden by presets, never by the phone :root block, and every var() used is defined', () => {
  const used = new Set([...after.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))
  const defined = new Set(afterRoot.decls.keys())
  for (const name of used) assert.ok(defined.has(name), `${name} is defined in :root`)
  // and no token in the registry is dead weight (a name nothing reads would silently do nothing for a theme)
  const registry = theme.TOKENS.map((t) => t.name)
  const reserved = new Set(['--raised', '--purple']) // documented as reserved
  const playerToo = fs.readFileSync(path.join(__dirname, '..', 'electron', 'browserChrome.js'), 'utf8')
  for (const name of registry) {
    if (reserved.has(name)) continue
    assert.ok(used.has(name) || playerToo.includes(`var(${name})`), `${name} is read by the stylesheet`)
  }
})

test('no theme-identity hex color is left hardcoded outside the :root defaults', () => {
  const body = stripComments(after).replace(/:root\{[^}]*\}/g, '')
  const left = new Map()
  for (const hex of body.match(/#[0-9a-fA-F]{3,8}\b/g) || []) left.set(hex, (left.get(hex) || 0) + 1)
  // What remains on purpose: drop shadows and the modal scrim (black at low alpha, right on any theme),
  // and one declaration in the first phone block that a later rule always overrides. The phone :root
  // override itself is the last group.
  const allowed = new Set(['#0003', '#0004', '#0005', '#070b1433', '#030713c9', '#101c32', '#0f1420', '#182033', '#232c42', '#e9ecf3', '#b9c1d4', '#e5b94e', '#303b54'])
  for (const hex of left.keys()) assert.ok(allowed.has(hex), `${hex} is hardcoded in browserTheme.css`)
})

test('browserChrome still exposes the stylesheet unchanged in shape', () => {
  assert.equal(browserChrome.styles.replace(/\r\n/g, '\n'), after)
  assert.ok(browserChrome.styles.includes('--page-glow'))
  assert.equal(typeof browserChrome.sidebar, 'function')
})

test('theme hooks: the extra rules only reach inline-styled markup, and their defaults equal the inline values', () => {
  assert.ok(hooks, 'hooks block present')
  const rules = stripComments(hooks[0]).trim().split('}').map((r) => r.trim()).filter(Boolean)
  assert.equal(rules.length, 3)
  for (const rule of rules) assert.match(rule, /^\.beebo-alphabet[^{]*\{(?:background|color):var\(--alpha-bar-(?:bg|text|off)\)!important$/)
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'streamServer.js'), 'utf8')
  const fn = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf('\n}', source.indexOf(`function ${name}(`)))
  const d = (name) => theme.TOKENS.find((t) => t.name === name).default
  for (const body of [fn('alphabetBarTop'), fn('alphabetRailSide')]) {
    assert.ok(body.includes(`background:${d('--alpha-bar-bg')}`), 'inline background equals --alpha-bar-bg default')
    assert.ok(body.includes(`color:${d('--alpha-bar-text')}`), 'inline letter color equals --alpha-bar-text default')
    assert.ok(body.includes(`color:${d('--alpha-bar-off')}`), 'inline empty-letter color equals --alpha-bar-off default')
  }
  assert.ok(fn('alphabetBarTop').includes('class="beebo-alphabet"') && fn('alphabetRailSide').includes('class="beebo-alphabet-rail"'))
})

test('docs/THEMING.md lists every theme variable and every preset, so the designer reference cannot drift', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'THEMING.md'), 'utf8')
  for (const tok of theme.TOKENS) assert.ok(doc.includes('`' + tok.name + '`'), `${tok.name} is documented`)
  for (const id of theme.PRESET_IDS) assert.ok(doc.includes('`' + id + '`'), `${id} is documented`)
  for (const group of theme.GROUPS) assert.ok(doc.includes('### ' + group.label), `${group.label} section exists`)
})
