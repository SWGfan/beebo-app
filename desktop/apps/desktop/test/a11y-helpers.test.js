// Accessibility helpers, as pure functions (there is no DOM test library in this repo):
// poster-grid arrow keys, roving Tab stops, dialog focus trap, the live-region announcer,
// colour contrast of the theme tokens, and the stylesheet rules WCAG needs.
// Run: node --test test/a11y-helpers.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const src = path.resolve(__dirname, '..', 'src')
const lib = (f) => import(pathToFileURL(path.join(src, 'lib', f)).href)

// A grid of `count` cards, `cols` per row, like the poster grid; a section break adds vertical space.
function gridRects(count, cols, { w = 160, h = 300, gap = 20, breakAfterRow = -1, breakGap = 60 } = {}) {
  const rects = []
  for (let i = 0; i < count; i += 1) {
    const row = Math.floor(i / cols)
    const extra = breakAfterRow >= 0 && row > breakAfterRow ? breakGap : 0
    rects.push({ left: (i % cols) * (w + gap), top: row * (h + gap) + extra, width: w, height: h })
  }
  return rects
}

test('arrow keys move between poster cards by where they are on screen', async () => {
  const { pickNeighbor } = await lib('gridNav.js')
  const r = gridRects(10, 4) // rows: 0-3, 4-7, 8-9
  assert.equal(pickNeighbor(r, 0, 'ArrowRight'), 1)
  assert.equal(pickNeighbor(r, 3, 'ArrowRight'), 4, 'wraps to the start of the next row like reading order')
  assert.equal(pickNeighbor(r, 9, 'ArrowRight'), -1, 'stops at the last card')
  assert.equal(pickNeighbor(r, 0, 'ArrowLeft'), -1)
  assert.equal(pickNeighbor(r, 4, 'ArrowLeft'), 3)
  assert.equal(pickNeighbor(r, 1, 'ArrowDown'), 5)
  assert.equal(pickNeighbor(r, 5, 'ArrowUp'), 1)
  assert.equal(pickNeighbor(r, 6, 'ArrowDown'), 9, 'the last row is short: the nearest card by position')
  assert.equal(pickNeighbor(r, 7, 'ArrowDown'), 9, 'column 3 has no card below: the nearest in the last row')
  assert.equal(pickNeighbor(r, 9, 'ArrowDown'), -1, 'nothing below the last row')
  assert.equal(pickNeighbor(r, 1, 'ArrowUp'), -1, 'nothing above the first row')
})

test('Home, End and Ctrl+Home/End, PageUp/PageDown', async () => {
  const { pickNeighbor } = await lib('gridNav.js')
  const r = gridRects(20, 4)
  assert.equal(pickNeighbor(r, 6, 'Home'), 4)
  assert.equal(pickNeighbor(r, 5, 'End'), 7)
  assert.equal(pickNeighbor(r, 4, 'Home'), -1, 'already at the start of the row')
  assert.equal(pickNeighbor(r, 6, 'Home', { ctrl: true }), 0)
  assert.equal(pickNeighbor(r, 6, 'End', { ctrl: true }), 19)
  assert.equal(pickNeighbor(r, 1, 'PageDown', { pageRows: 2 }), 9)
  assert.equal(pickNeighbor(r, 17, 'PageUp', { pageRows: 2 }), 9)
  assert.equal(pickNeighbor(r, 17, 'PageDown', { pageRows: 3 }), -1, 'already in the last row')
  assert.equal(pickNeighbor(r, 1, 'PageDown', { pageRows: 99 }), 17, 'stops at the last row')
  assert.equal(pickNeighbor(r, 1, 'x'), -1)
  assert.equal(pickNeighbor([], 0, 'ArrowDown'), -1)
  assert.equal(pickNeighbor(r, 99, 'ArrowDown'), -1)
})

test('vertical movement works across A-Z section headings and any column count', async () => {
  const { pickNeighbor } = await lib('gridNav.js')
  // 6 columns, a heading gap after the first row (the "B" section starts on a new row)
  const r = gridRects(9, 6, { breakAfterRow: 0 })
  assert.equal(pickNeighbor(r, 2, 'ArrowDown'), 8, 'goes to the row below the heading, same column')
  assert.equal(pickNeighbor(r, 8, 'ArrowUp'), 2)
  // a section that ends mid-row (3 cards), then the next section starts on a fresh row
  const sections = [
    { left: 0, top: 0, width: 160, height: 300 }, { left: 180, top: 0, width: 160, height: 300 }, { left: 360, top: 0, width: 160, height: 300 },
    { left: 0, top: 400, width: 160, height: 300 }, { left: 180, top: 400, width: 160, height: 300 }
  ]
  assert.equal(pickNeighbor(sections, 2, 'ArrowDown'), 4, 'nearest card by horizontal position when the column is empty')
  assert.equal(pickNeighbor(sections, 0, 'ArrowDown'), 3)
  // one column (a narrow window at 200% zoom)
  const one = gridRects(4, 1)
  assert.equal(pickNeighbor(one, 0, 'ArrowDown'), 1)
  assert.equal(pickNeighbor(one, 2, 'ArrowUp'), 1)
  assert.equal(pickNeighbor(one, 0, 'End'), -1)
})

test('toolbars: arrows wrap, Home and End jump, and one item keeps the Tab stop', async () => {
  const { pickLinear, chooseRover } = await lib('gridNav.js')
  assert.equal(pickLinear(5, 4, 'ArrowRight'), 0)
  assert.equal(pickLinear(5, 0, 'ArrowLeft'), 4)
  assert.equal(pickLinear(5, 2, 'ArrowDown'), 3)
  assert.equal(pickLinear(5, 2, 'Home'), 0)
  assert.equal(pickLinear(5, 2, 'End'), 4)
  assert.equal(pickLinear(0, 0, 'ArrowRight'), -1)
  assert.equal(pickLinear(5, 2, 'q'), -1)
  const items = [{ usable: true }, { usable: false }, { usable: true, current: true }, { usable: true }]
  assert.equal(chooseRover(items, 3), 3, 'the remembered item stays the Tab stop')
  assert.equal(chooseRover(items, 1), 2, 'a remembered item that is now disabled falls back to the current one')
  assert.equal(chooseRover(items, -1), 2, 'with nothing remembered, the selected item')
  assert.equal(chooseRover([{ usable: false }, { usable: true }], -1), 1, 'else the first usable one')
  assert.equal(chooseRover([{ usable: false }], -1), -1)
  assert.equal(chooseRover([], -1), -1)
})

test('a dialog keeps Tab inside itself', async () => {
  const { trapTarget } = await lib('focusTrap.js')
  assert.equal(trapTarget(3, 2, false), 0, 'Tab on the last control wraps to the first')
  assert.equal(trapTarget(3, 0, true), 2, 'Shift+Tab on the first wraps to the last')
  assert.equal(trapTarget(3, 1, false), -1, 'inside the dialog the browser does the moving')
  assert.equal(trapTarget(3, 1, true), -1)
  assert.equal(trapTarget(3, -1, false), 0, 'focus that escaped is pulled back in')
  assert.equal(trapTarget(3, -1, true), 2)
  assert.equal(trapTarget(0, -1, false), -1, 'nothing to focus')
  assert.equal(trapTarget(1, 0, false), 0, 'a single control keeps focus')
})

test('the live-region announcer speaks politely or assertively and repeats identical messages', async () => {
  const { createAnnouncer } = await lib('announcer.js')
  const made = []
  const doc = {
    body: { appendChild: (el) => { el.isConnected = true; made.push(el) } },
    createElement: () => {
      const attrs = {}
      return { className: '', textContent: '', setAttribute: (k, v) => { attrs[k] = v }, getAttribute: (k) => attrs[k], attrs }
    }
  }
  const queue = []
  const announcer = createAnnouncer({ document: doc, setTimer: (fn, ms) => { queue.push({ fn, ms }); return queue.length }, clearTimer: () => {} })
  assert.equal(announcer.announce('   '), false)
  assert.equal(announcer.announce(42), false)
  assert.equal(announcer.announce('Movies opened'), true)
  assert.equal(made.length, 1)
  assert.equal(made[0].attrs.role, 'status')
  assert.equal(made[0].attrs['aria-live'], 'polite')
  assert.equal(made[0].className, 'sr-only', 'hidden visually, still read')
  assert.equal(made[0].textContent, '', 'emptied first so the same text is announced again')
  queue.shift().fn()
  assert.equal(made[0].textContent, 'Movies opened')
  queue.shift().fn()
  assert.equal(made[0].textContent, '', 'cleared after a while')
  announcer.announce('Error', { assertive: true })
  assert.equal(made.length, 2)
  assert.equal(made[1].attrs.role, 'alert')
  assert.equal(made[1].attrs['aria-live'], 'assertive')
  announcer.announce('Again')
  assert.equal(made.length, 2, 'regions are reused')
})

test('colour maths: known ratios', async () => {
  const { contrastRatio, parseColor, over, meetsAA } = await lib('contrast.js')
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(1), '21.0')
  assert.equal(contrastRatio('#fff', '#fff').toFixed(1), '1.0')
  assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), '4.48', 'the classic just-failing grey')
  assert.equal(meetsAA('#767676', '#ffffff'), true)
  assert.equal(meetsAA('#777777', '#ffffff'), false)
  assert.equal(meetsAA('#777777', '#ffffff', { large: true }), true)
  assert.deepEqual(parseColor('#0f8'), { r: 0, g: 255, b: 136, a: 1 })
  assert.equal(parseColor('red'), null)
  assert.deepEqual(over('#ffffff80', '#000000'), { r: 128, g: 128, b: 128, a: 1 })
})

// The theme's own tokens (the last :root block in styles.css wins, as in the browser).
function themeTokens() {
  const css = fs.readFileSync(path.join(src, 'styles.css'), 'utf8')
  const tokens = {}
  for (const m of css.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) tokens[m[1]] = m[2]
  return tokens
}

test('theme text colours meet WCAG AA (4.5:1) on every surface they are used on', async () => {
  const { contrastRatio, AA_TEXT, AA_LARGE_OR_UI } = await lib('contrast.js')
  const t = themeTokens()
  for (const need of ['text', 'muted', 'link', 'bg', 'panel', 'surface-raised', 'focus', 'accent']) assert.ok(t[need], `--${need} exists`)
  const surfaces = { bg: t.bg, panel: t.panel, 'surface-raised': t['surface-raised'], 'card (gradient end)': '#101827', 'toolbar': '#10233c', 'sidebar (bottom)': '#090b14' }
  for (const [name, back] of Object.entries(surfaces)) {
    for (const fg of ['text', 'muted', 'link']) {
      const ratio = contrastRatio(t[fg], back)
      assert.ok(ratio >= AA_TEXT, `--${fg} on ${name} is ${ratio.toFixed(2)}:1, needs ${AA_TEXT}`)
    }
  }
  // buttons and states used in the screens
  const pairs = [
    ['white on the active nav gradient', '#ffffff', '#6840b5'], ['white on the active nav gradient (end)', '#ffffff', '#304d8e'],
    ['white on the primary button', '#ffffff', '#7144c3'], ['white on the primary button (end)', '#ffffff', '#355997'],
    ['white on the active tab', '#ffffff', '#6540b1'], ['sidebar nav text', '#c6d2e9', '#0c1428'],
    ['sidebar group title', '#8fa4c7', '#0c1428'], ['footer version', '#f5a524', '#090b14'],
    ['error text', '#ffb6b6', t.bg], ['placeholder', '#a3b0cb', '#0b1528'], ['NEW ribbon', '#08210c', '#4caf50'],
    ['"No poster" text (was #555)', t.muted, '#080d18']
  ]
  for (const [name, fg, back] of pairs) {
    const ratio = contrastRatio(fg, back)
    assert.ok(ratio >= AA_TEXT, `${name}: ${ratio.toFixed(2)}:1`)
  }
  // non-text: the focus ring must stand out from every background (3:1)
  for (const back of [t.bg, t.panel, t['surface-raised'], '#0c1428']) {
    const ratio = contrastRatio(t.focus, back)
    assert.ok(ratio >= AA_LARGE_OR_UI, `focus ring on ${back}: ${ratio.toFixed(2)}:1`)
  }
})

test('a11y.css carries the rules WCAG needs', () => {
  const css = fs.readFileSync(path.join(src, 'a11y.css'), 'utf8')
  assert.match(css, /\.sr-only\s*\{/, 'screen-reader-only text')
  assert.match(css, /\.skip-link\s*\{/, 'skip link')
  assert.match(css, /\.skip-link:focus/, 'skip link shows on focus')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'reduced motion')
  assert.match(css, /animation-duration:\s*\.001ms/, 'animations stop too, not only transitions')
  assert.match(css, /@media \(max-height: 640px\)[\s\S]*?\.sticky-bar\s*\{\s*position:\s*static/, '200% zoom: the toolbar stops pinning')
  assert.match(css, /@media \(max-width: 760px\)/, 'reflow at narrow widths')
  assert.match(css, /forced-colors: active/, 'Windows high contrast')
  assert.match(css, /\.poster-card:focus-visible/, 'poster cards show focus')
  assert.match(css, /html\[dir='rtl'\]/, 'right-to-left switch')
})

test('the main window has the landmarks and hooks the keyboard layer relies on', () => {
  const app = fs.readFileSync(path.join(src, 'App.jsx'), 'utf8')
  assert.match(app, /<SkipLink \/>/, 'skip link is first in the window')
  assert.match(app, /<main className="main" id=\{MAIN_ID\} tabIndex=\{-1\}[ >]/, 'main landmark, focusable by the skip link')
  assert.match(app, /aria-current=/, 'the current page is marked in the sidebar')
  assert.match(app, /announce\(t\('a11y\.pageOpened'/, 'page changes are announced')
  const main = fs.readFileSync(path.join(src, 'main.jsx'), 'utf8')
  assert.match(main, /installGridNav\(\)/)
  assert.match(main, /bootI18n\(\)/)
  const controls = fs.readFileSync(path.join(src, 'components', 'LibraryControls.jsx'), 'utf8')
  assert.match(controls, /data-rove="horizontal"/)
  assert.match(controls, /aria-pressed=\{active === tab\.key\}/, 'view tabs say which one is selected')
  const shell = fs.readFileSync(path.join(src, 'components', 'SidebarShell.jsx'), 'utf8')
  assert.match(shell, /aria-expanded/, 'the hamburger reports whether the panel is open')
})
