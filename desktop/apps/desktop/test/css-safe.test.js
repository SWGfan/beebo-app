'use strict'
// The CSS sanitizer and hostile pack files. A pack is data: variables from the registry with color / gradient /
// size values. Nothing a file can contain may reach a stylesheet except values the grammar re-serialises, and
// every malicious fixture must be refused whole (a pack is all or nothing).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const cssSafe = require('../electron/cssSafe')
const packs = require('../electron/packs')
const prefs = require('../electron/prefsStore')

const BS = String.fromCharCode(92) // a backslash, spelled so no tooling can eat it
const FIXTURES = path.join(__dirname, 'fixtures', 'packs', 'malicious')

test('good values pass and come out canonical', () => {
  const r = cssSafe.sanitizeVars({ '--bg': '#ABCDEF', '--text': 'rgb( 1 , 2 , 3 )', '--card-bg': 'linear-gradient(145deg, #111 0, #222 100%)', '--radius-card': '12px' })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.vars['--bg'], '#abcdef')
  assert.equal(r.vars['--text'], 'rgb(1,2,3)')
  assert.equal(r.vars['--card-bg'], 'linear-gradient(145deg,#111 0,#222 100%)')
  assert.equal(r.vars['--radius-card'], '12px')
})

const HOSTILE_VALUES = [
  'url(https://evil.example/x.png)', 'URL( "http://evil.example" )', 'u/**/rl(https://x)', BS + '75rl(https://x)', BS + '000075rl(x)',
  "image-set('a.png' 1x)", 'src(x)', 'element(#a)', 'paint(foo)', '-webkit-image-set(x)', 'cross-fade(x)',
  'expression(alert(1))', 'EXPRESSION(alert(1))', 'javascript:alert(1)', 'vbscript:x', 'behavior:url(x)', '-moz-binding:url(x)',
  '#fff; } @import url(https://x); a{', '@import "x.css"', '@font-face{src:url(x)}', '#fff}body{x:y', '{}', '<script>', '#fff<', '#fff>',
  "'#fff'", '"#fff"', '`#fff`', '#fff !important', '#fff & #000', 'var(--other)', 'calc(1px + 2px)', 'env(safe-area-inset-top)', 'attr(x)',
  'min(1px,2px)', 'max(1px,2px)', 'clamp(1px,2px,3px)', 'data:image/svg+xml,<svg/>', 'https://evil.example', 'http://x', '//evil.example/x',
  'ftp://x', 'file:///etc/passwd', 'red', 'inherit', 'initial', '', ' ', 'x'.repeat(301), '#fff' + String.fromCharCode(0), '#fff\n#000',
  String.fromCharCode(0xff55, 0xff52, 0xff4c) + '(x)', // fullwidth "url"
  '#fff' + String.fromCharCode(0x202e) + '000', '#f' + String.fromCharCode(0x200b) + 'ff', String.fromCharCode(0xe9) + '#fff',
  '#ggg', '#12', '#12345', 'rgb(300,0,0)', 'rgba(0,0,0,2)', 'hsl(400,10%,10%)', 'linear-gradient(url(x),#fff)', 'linear-gradient(red,blue)',
  'linear-gradient(#fff)', 'linear-gradient(' + Array(12).fill('#fff').join(',') + ')', 'radial-gradient(#fff,#000 200%)', 'conic-gradient(#fff,#000)',
  'repeating-linear-gradient(#fff,#000)', 'linear-gradient(145deg,#fff,#000),linear-gradient(145deg,#fff,#000),linear-gradient(145deg,#fff,#000),linear-gradient(145deg,#fff,#000)'
]

test('hostile VALUES are refused for every variable type', () => {
  const names = ['--bg', '--card-bg', '--page-glow', '--radius-card']
  for (const value of HOSTILE_VALUES) {
    for (const name of names) {
      const r = cssSafe.sanitizeVars({ [name]: value })
      assert.equal(r.ok, false, `${name}: ${JSON.stringify(value).slice(0, 60)} must be refused`)
      assert.deepEqual(r.vars, {}, 'a refused map yields nothing')
    }
  }
})

test('hostile NAMES are refused: unknown, look-alike, reserved, injected', () => {
  const names = ['--evil', '--BG', 'bg', 'background', 'color', '--bg;color', '--bg}', '--bg ', ' --bg', '--', '--x'.repeat(30), '__proto__', 'constructor', 'prototype', '--bg' + String.fromCharCode(0x200b), '--b' + String.fromCharCode(0x0433)]
  for (const name of names) {
    const input = {}
    Object.defineProperty(input, name, { value: '#000000', enumerable: true })
    assert.equal(cssSafe.sanitizeVars(input).ok, false, JSON.stringify(name))
  }
  assert.equal(cssSafe.sanitizeVars(['--bg']).ok, false, 'an array is not a map')
  assert.equal(cssSafe.sanitizeVars('--bg: #000;').ok, false, 'CSS text is not a map')
  assert.equal(cssSafe.sanitizeVars({ '--bg': { toString: () => '#000' } }).ok, false, 'objects are not coerced')
  assert.equal(cssSafe.sanitizeVars({ '--bg': ['#000'] }).ok, false)
  assert.equal(cssSafe.sanitizeVars({ '--bg': 5 }).ok, false)
  assert.equal(cssSafe.sanitizeVars({ '--bg': null }).ok, false)
})

test('size limits: too many entries and too much text are refused', () => {
  const many = {}
  for (let i = 0; i < 130; i++) many['--v' + i] = '#000'
  assert.equal(cssSafe.sanitizeVars(many).ok, false)
  assert.equal(cssSafe.screenText('#000'.padEnd(cssSafe.LIMITS.maxValueLength + 1, '0')) !== null, true)
})

test('declarations() and rule() rebuild CSS from sanitized values only', () => {
  assert.equal(cssSafe.declarations({ '--bg': '#000000', '--text': '#ffffff' }), '--bg:#000000;--text:#ffffff;')
  assert.equal(cssSafe.declarations({ '--bg': 'url(x)' }), '', 'a bad map yields no CSS at all')
  assert.equal(cssSafe.rule(':root[data-theme]', { '--bg': '#000' }), ':root[data-theme]{--bg:#000;}')
  assert.equal(cssSafe.rule('body{}x', { '--bg': '#000' }), '', 'a selector must be plain and code-supplied')
  assert.equal(cssSafe.rule(':root', {}), '')
})

test('fuzz: random mixes of hostile fragments never produce a value that survives with unsafe characters', () => {
  const frags = ['url(', ')', '{', '}', ';', '@import', BS, '/*', '*/', '"', "'", '<', '>', 'expression(', 'javascript:', 'http://', '#fff', 'rgb(1,2,3)', 'linear-gradient(', ',', ' ', 'data:', '!important', '&', '--x']
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (let i = 0; i < 2000; i++) {
    let s = ''
    for (let n = 0, len = 1 + Math.floor(rnd() * 8); n < len; n++) s += frags[Math.floor(rnd() * frags.length)]
    const r = cssSafe.sanitizeVars({ '--card-bg': s })
    if (r.ok) {
      assert.match(r.vars['--card-bg'], /^[#a-z0-9%.,()\s-]+$/, `survivor ${JSON.stringify(s)} -> ${r.vars['--card-bg']}`)
      assert.ok(!/url|import|expression|javascript|[{};@\\"'<>&!]/i.test(r.vars['--card-bg']))
    }
  }
})

// ---- malicious pack FILES ----------------------------------------------------------------------------------

test('every malicious fixture file is refused by the pack validator', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
  assert.ok(files.length >= 7, 'the corpus is present')
  for (const file of files) {
    const parsed = packs.parseFileText(fs.readFileSync(path.join(FIXTURES, file), 'utf8'))
    assert.equal(parsed.ok, true, file + ' is valid JSON (the attack is in the content)')
    const r = packs.validatePack(parsed.value)
    assert.equal(r.ok, false, file + ' must be refused')
    assert.ok(r.errors.length > 0)
    assert.equal(({}).polluted, undefined, file + ' polluted Object.prototype')
  }
})

test('hostile pack files are also refused end to end (import), storing nothing', () => {
  const data = {}
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)) }, delete: (k) => { delete data[k] } }
  for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    const parsed = packs.parseFileText(fs.readFileSync(path.join(FIXTURES, file), 'utf8'))
    for (const dryRun of [true, false]) {
      const r = prefs.importFile(store, 'ann', parsed.value, { dryRun })
      assert.equal(r.ok, false, `${file} dryRun=${dryRun}`)
    }
  }
  assert.deepEqual(Object.keys(data), [], 'nothing was written')
})

test('oversize, deep, non-JSON and wrong-format files are refused before validation', () => {
  assert.equal(packs.parseFileText('x'.repeat(300 * 1024)).ok, false)
  assert.equal(packs.parseFileText('{not json').ok, false)
  assert.equal(packs.parseFileText(Buffer.from('a')).ok, false)
  assert.equal(packs.validatePack({ format: 'something-else', v: 1 }).ok, false)
  assert.equal(packs.validatePack({ format: 'beebo-pack', v: 2, kind: 'theme' }).ok, false)
  assert.match(packs.validatePack({ format: 'beebo-pack', v: 2 }).errors[0], /newer/)
  assert.equal(packs.validatePack(null).ok, false)
  assert.equal(packs.validatePack([]).ok, false)
  let deep = { a: 1 }
  for (let i = 0; i < 20; i++) deep = { a: deep }
  assert.equal(packs.validatePack({ format: 'beebo-pack', v: 1, kind: 'theme', content: deep }).ok, false)
})

test('a well-formed pack with one bad variable is refused whole, and the error names the variable', () => {
  const good = packs.loadBundled().theme[0]
  const file = JSON.parse(JSON.stringify(packs.toFile(good)))
  delete file.integrity
  file.content.vars['--noposter-bg'] = 'url(https://evil.example/x)'
  const r = packs.validatePack(file)
  assert.equal(r.ok, false)
  assert.match(r.errors.join(' '), /--noposter-bg/)
})

test('text fields cannot carry markup-looking or invisible characters into the UI', () => {
  const base = () => JSON.parse(JSON.stringify(packs.toFile(packs.loadBundled().layout[0])))
  for (const name of ['Nice' + String.fromCharCode(0x202e) + 'gnp', 'a' + String.fromCharCode(0x200b) + 'b', 'line' + String.fromCharCode(10) + 'break', 'x'.repeat(41), '']) {
    const f = base(); delete f.integrity; f.name = name
    assert.equal(packs.validatePack(f).ok, false, JSON.stringify(name))
  }
  const ok = base(); delete ok.integrity; ok.name = 'Caf' + String.fromCharCode(0xe9) + ' noir'
  assert.equal(packs.validatePack(ok).ok, true, 'ordinary accented letters are fine')
  // markup in a name is harmless data (the UI renders text, never HTML), but a link is only https
  const link = base(); delete link.integrity; link.author.url = 'javascript:alert(1)'
  assert.equal(packs.validatePack(link).ok, false)
})
