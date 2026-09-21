import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jsDir = path.join(root, 'app', 'js')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('no source file uses an HTML-injecting or code-evaluating sink', () => {
  const banned = [
    [/\.innerHTML\b/, 'innerHTML'], [/\.outerHTML\b/, 'outerHTML'], [/insertAdjacentHTML/, 'insertAdjacentHTML'],
    [/document\.write/, 'document.write'], [/\beval\s*\(/, 'eval'], [/new\s+Function\s*\(/, 'new Function'],
    [/setTimeout\s*\(\s*['"`]/, 'setTimeout(string)'], [/setInterval\s*\(\s*['"`]/, 'setInterval(string)'],
    [/\.srcdoc\b/, 'srcdoc'], [/createContextualFragment/, 'createContextualFragment'], [/DOMParser/, 'DOMParser'],
    [/location\s*(\.href)?\s*=/, 'location assignment'], [/window\.open/, 'window.open']
  ]
  const files = walk(jsDir)
  assert.ok(files.length > 15)
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    for (const [re, name] of banned) assert.ok(!re.test(src), path.relative(jsDir, f) + ' uses ' + name)
  }
})

test('the token is never put in a URL or a log in the source', () => {
  for (const f of walk(jsDir)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(src), path.relative(jsDir, f) + ' logs to the console')
    assert.ok(!/[?&]token=/.test(src), path.relative(jsDir, f) + ' builds a ?token= URL')
    assert.ok(!/[?&]access_token=/.test(src))
  }
})

// ---- a minimal fake DOM, strict about the dangerous setters ---------------------------------------
class FakeEl {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this.className = ''; this._text = ''; this.handlers = {}; this.parentNode = null }
  set innerHTML(v) { throw new Error('innerHTML assigned: ' + v) }
  get innerHTML() { throw new Error('innerHTML read') }
  set textContent(v) { this._text = String(v); this.children = [] }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join('') }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null }
  addEventListener(t, fn) { this.handlers[t] = fn }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  querySelectorAll() { return [] }
}
globalThis.document = {
  createElement: (t) => new FakeEl(t),
  createTextNode: (t) => { const n = new FakeEl('#text'); n._text = String(t); return n }
}

const { h, focusable } = await import('../app/js/dom.js')
const { posterTile, button, stateBox, railState } = await import('../app/js/ui.js')
const { normalizeMovie, normalizeEpisodes } = await import('../app/js/util/models.js')

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>'

test('h(): text goes in as textContent; on*/style/src/href/srcdoc attributes are refused', () => {
  const el = h('div', {
    text: EVIL,
    attrs: { onclick: 'alert(1)', ONMOUSEOVER: 'x', style: 'background:url(javascript:1)', src: 'http://evil', href: 'javascript:1', srcdoc: '<b>', formaction: 'x', role: 'button' },
    data: { f: '1' }
  })
  assert.equal(el.textContent, EVIL)
  assert.deepEqual(Object.keys(el.attrs).sort(), ['data-f', 'role'])
})

test('h(): string children become text nodes, not markup', () => {
  const el = h('div', {}, [EVIL, null, false, h('span', { text: 'ok' })])
  assert.equal(el.textContent, EVIL + 'ok')
})

test('posterTile with a hostile server item: markup stays text, hostile image paths are not loaded', () => {
  const item = normalizeMovie({ id: 'x', title: EVIL, year: 2000, poster: '//evil.example/p.jpg', isNew: true })
  const tile = posterTile(item, { origin: 'http://192.168.1.2:47811', onSelect: () => {} })
  assert.ok(tile.textContent.includes(EVIL))
  const img = tile.children[0].children[0]
  assert.equal(img.tag, 'img')
  assert.equal(img.getAttribute('data-src'), null, 'a protocol-relative poster path must not become an image URL')
  assert.equal(img.getAttribute('src'), null)
  assert.equal(tile.getAttribute('data-f'), '1')
})

test('posterTile with a good server-relative poster builds a lazy data-src on the user\'s server only', () => {
  const item = normalizeMovie({ id: 'x', title: 'T', poster: '/media/poster/1.jpg' })
  const tile = posterTile(item, { origin: 'http://192.168.1.2:47811' })
  const img = tile.children[0].children[0]
  assert.equal(img.getAttribute('data-src'), 'http://192.168.1.2:47811/media/poster/1.jpg')
  assert.equal(img.getAttribute('src'), null, 'not loaded until near the screen')
})

test('stateBox / button / railState use text for every message, including hostile server errors', () => {
  const box = stateBox({ title: EVIL, message: EVIL, actions: [{ label: EVIL, onSelect: () => {} }] })
  assert.ok(box.textContent.includes(EVIL))
  assert.equal(button(EVIL, () => {}).textContent, EVIL)
  assert.equal(railState(EVIL).textContent, EVIL)
})

test('episode rows from a hostile server are sanitised before they reach the views', () => {
  const e = normalizeEpisodes({
    show: { key: 'k', name: EVIL, overview: EVIL, poster: 'javascript:alert(1)' },
    seasons: [{ season: 1, episodes: [{ id: 'e', title: EVIL, episodeName: EVIL, stream: 'http://evil/x' }] }]
  })
  assert.equal(e.show.poster, null)
  assert.equal(e.seasons[0].episodes[0].stream, null)
  const row = h('div', { text: e.seasons[0].episodes[0].title })
  assert.equal(row.textContent, EVIL)
})

test('focusable() only attaches a handler property, never markup', () => {
  const el = focusable(h('div', { text: 'x' }), () => 1)
  assert.equal(el.getAttribute('data-f'), '1')
  assert.equal(typeof el.onSelect, 'function')
})
