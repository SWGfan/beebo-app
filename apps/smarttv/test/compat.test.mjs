import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkJs, checkCss, checkTree } from '../tools/check-compat.mjs'

let acorn = null
try { acorn = await import('acorn') } catch (e) { acorn = null }
const skip = acorn ? false : 'acorn not installed (run npm install)'

test('the shipped app parses as ES2018 and uses no post-Chromium-63 API', { skip }, async () => {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app')
  const { findings, files } = await checkTree(appDir)
  assert.deepEqual(findings, [])
  assert.ok(files > 10, 'scanned the app files')
})

test('the checker really rejects modern syntax', { skip }, async () => {
  const bad = {
    'optional chaining': 'var x = a?.b',
    'nullish coalescing': 'var x = a ?? b',
    'optional catch binding': 'try { f() } catch { g() }',
    'class field': 'class A { x = 1 }',
    'dynamic import': 'import("./x.js")',
    'bigint': 'var n = 10n',
    'numeric separator': 'var n = 1_000'
  }
  for (const [name, src] of Object.entries(bad)) {
    const f = await checkJs(src, 't.js', acorn)
    assert.ok(f.length > 0, name + ' must be flagged')
  }
})

test('the checker flags newer built-ins but not the same words in strings/comments', { skip }, async () => {
  assert.ok((await checkJs('"a-b".replaceAll("-", " ")', 't.js', acorn)).length === 1)
  assert.ok((await checkJs('[[1]].flat()', 't.js', acorn)).length === 1)
  assert.ok((await checkJs('Object.fromEntries([])', 't.js', acorn)).length === 1)
  assert.ok((await checkJs('new AbortController()', 't.js', acorn)).length === 1)
  assert.ok((await checkJs('var g = globalThis', 't.js', acorn)).length === 1)
  assert.ok((await checkJs('el.focus({ preventScroll: true })', 't.js', acorn)).length === 1)
  assert.equal((await checkJs('// replaceAll globalThis\nvar s = "flat replaceAll AbortController"', 't.js', acorn)).length, 0)
  assert.equal((await checkJs('var o = { a: 1 }; var p = Object.assign({}, o); Object.entries(p).forEach(function () {})', 't.js', acorn)).length, 0)
})

test('the checker accepts ES2018 features we do rely on', { skip }, async () => {
  const ok = 'export async function f(x) { const { a, ...rest } = x; return [...Object.keys({ ...rest, a })].map((k) => `${k}`) }'
  assert.deepEqual(await checkJs(ok, 't.js', acorn), [])
})

test('css check flags newer properties and passes safe ones', () => {
  const bad = [
    '.a { display: flex; gap: 10px }', '.a { row-gap: 4px }', '.a { aspect-ratio: 2/3 }', '.a { inset: 0 }',
    '.a:focus-visible { outline: 0 }', '.a:is(.b) {}', '.a { width: clamp(1px, 2px, 3px) }', '.a { width: min(1px, 2px) }',
    '.a { backdrop-filter: blur(2px) }', '.a { translate: 1px }'
  ]
  for (const css of bad) assert.ok(checkCss(css, 't.css').length > 0, css)
  const good = '.a { display: flex; grid-gap: 10px; margin-right: 12px; transform: translateX(4px) scale(1.05); top: 0; right: 0; ' +
    'padding-top: 150%; color: var(--c); background: linear-gradient(#000, #111) } /* gap: 4px is fine in a comment */ .b > .c + .d { opacity: .5 }'
  assert.deepEqual(checkCss(good, 't.css'), [])
  assert.deepEqual(checkCss('.a { min-width: 10px; max-height: 5px; text-shadow: 0 0 1px #000 }', 't.css'), [])
})
