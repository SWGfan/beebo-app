// The left navigation panel's three modes (src/lib/sidebarMode.js): always shown, show on
// hover, hidden until the hamburger is pressed. The controller takes its timers as
// arguments, so every delay here runs on a fake clock and the tests finish instantly.
// Run: node --test test/sidebar-mode.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const appRoot = path.resolve(__dirname, '..')
const load = () => import(pathToFileURL(path.join(appRoot, 'src', 'lib', 'sidebarMode.js')).href)

function fakeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map()
  return {
    setTimer(fn, ms) { nextId += 1; timers.set(nextId, { fn, at: now + ms }); return nextId },
    clearTimer(id) { timers.delete(id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let due = null
        for (const [id, t] of timers) if (t.at <= end && (due === null || t.at < timers.get(due).at)) due = id
        if (due === null) break
        const t = timers.get(due)
        timers.delete(due)
        now = t.at
        t.fn()
      }
      now = end
    },
    pending: () => timers.size
  }
}

const PANEL = 232

async function make(mode) {
  const M = await load()
  const clock = fakeClock()
  const ctl = M.createSidebarController({ mode, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
  return { M, clock, ctl }
}

test('the default is always shown, and unknown saved values fall back to it', async () => {
  const M = await load()
  assert.equal(M.DEFAULT_SIDEBAR_MODE, 'pinned')
  for (const bad of [undefined, null, '', 'floating', 3, {}]) assert.equal(M.normalizeSidebarMode(bad), 'pinned')
  for (const good of M.SIDEBAR_MODES) assert.equal(M.normalizeSidebarMode(good), good)
  assert.equal(M.createSidebarController({ mode: 'nonsense' }).getState().mode, 'pinned')
})

test('pinned is always visible and ignores the pointer, Escape and the hamburger', async () => {
  const { clock, ctl } = await make('pinned')
  assert.equal(ctl.getState().visible, true)
  ctl.pointerMoved(2, PANEL)
  clock.advance(1000)
  assert.equal(ctl.toggle(), 'none', 'the hamburger opens the mode menu instead')
  assert.equal(ctl.dismiss(), false)
  assert.equal(ctl.pageSelected(), false)
  assert.equal(ctl.getState().visible, true)
  assert.equal(clock.pending(), 0)
})

test('hover: resting at the left edge opens it after the open delay, not before', async () => {
  const { M, clock, ctl } = await make('hover')
  assert.equal(ctl.getState().visible, false)
  ctl.pointerMoved(3, PANEL)
  clock.advance(M.OPEN_DELAY_MS - 1)
  assert.equal(ctl.getState().visible, false)
  clock.advance(1)
  assert.equal(ctl.getState().visible, true)
  assert.equal(ctl.getState().explicit, false)
})

test('hover: a pointer that only passes through the edge does not open it', async () => {
  const { M, clock, ctl } = await make('hover')
  ctl.pointerMoved(4, PANEL)
  clock.advance(M.OPEN_DELAY_MS - 20)
  ctl.pointerMoved(M.EDGE_WIDTH_PX + 1, PANEL)
  clock.advance(1000)
  assert.equal(ctl.getState().visible, false)
  assert.equal(clock.pending(), 0)
})

test('hover: the pointer must be within the edge zone, not merely near the panel', async () => {
  const { clock, ctl } = await make('hover')
  ctl.pointerMoved(100, PANEL)
  clock.advance(1000)
  assert.equal(ctl.getState().visible, false)
})

async function openedByHover() {
  const made = await make('hover')
  made.ctl.pointerMoved(2, PANEL)
  made.clock.advance(made.M.OPEN_DELAY_MS)
  assert.equal(made.ctl.getState().visible, true)
  return made
}

test('hover: stays open while the pointer is over the panel, closes a grace period after it leaves', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.pointerMoved(150, PANEL)
  clock.advance(5000)
  assert.equal(ctl.getState().visible, true)
  ctl.pointerMoved(600, PANEL)
  clock.advance(M.CLOSE_DELAY_MS - 1)
  assert.equal(ctl.getState().visible, true)
  clock.advance(1)
  assert.equal(ctl.getState().visible, false)
})

test('hover: coming back inside the grace period cancels the close', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.pointerMoved(600, PANEL)
  clock.advance(M.CLOSE_DELAY_MS - 50)
  ctl.pointerMoved(120, PANEL)
  clock.advance(5000)
  assert.equal(ctl.getState().visible, true)
})

test('hover: keyboard focus inside the panel keeps it open until focus leaves', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.pointerMoved(600, PANEL)
  ctl.setFocusWithin(true)
  clock.advance(5000)
  assert.equal(ctl.getState().visible, true)
  ctl.setFocusWithin(false)
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
})

test('hover: an open mode menu keeps it open', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.setMenuOpen(true)
  ctl.pointerMoved(600, PANEL)
  clock.advance(5000)
  assert.equal(ctl.getState().visible, true)
  ctl.setMenuOpen(false)
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
})

test('hover: the pointer leaving the window, or the window losing focus, starts the close', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.pointerMoved(100, PANEL)
  ctl.pointerLeft()
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
})

test('hover: a focus flag left over from before it closed cannot pin it open next time', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.setFocusWithin(true)
  ctl.dismiss()
  assert.equal(ctl.getState().visible, false)
  ctl.pointerMoved(2, PANEL)
  clock.advance(M.OPEN_DELAY_MS)
  ctl.pointerMoved(600, PANEL)
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
})

test('hamburger opens it explicitly in hover mode: the pointer leaving does not close it', async () => {
  const { clock, ctl } = await make('hover')
  assert.equal(ctl.toggle(), 'opened')
  assert.equal(ctl.getState().explicit, true)
  ctl.pointerMoved(700, PANEL)
  clock.advance(10000)
  assert.equal(ctl.getState().visible, true)
  assert.equal(ctl.toggle(), 'closed')
  assert.equal(ctl.getState().visible, false)
})

test('hidden: hover does nothing, the hamburger opens it, and Escape / outside click / picking a page close it', async () => {
  const { clock, ctl } = await make('hidden')
  ctl.pointerMoved(1, PANEL)
  clock.advance(1000)
  assert.equal(ctl.getState().visible, false)
  ctl.toggle()
  assert.equal(ctl.getState().visible, true)
  assert.equal(ctl.dismiss(), true)
  assert.equal(ctl.getState().visible, false)
  assert.equal(ctl.dismiss(), false, 'nothing to dismiss when closed')
  ctl.toggle()
  assert.equal(ctl.pageSelected(), true)
  assert.equal(ctl.getState().visible, false)
})

test('picking a page: a hover-opened panel under the mouse stays, a keyboard-driven or hamburger-opened one closes', async () => {
  const { ctl, clock, M } = await openedByHover()
  ctl.pointerMoved(100, PANEL)
  assert.equal(ctl.pageSelected(), false, 'mouse user may click through several pages')
  assert.equal(ctl.getState().visible, true)
  ctl.setFocusWithin(true)
  assert.equal(ctl.pageSelected(), true, 'keyboard user is done once a page opens')
  assert.equal(ctl.getState().visible, false)
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
})

test('after a deliberate close the pointer has to leave the edge before hover can open it again', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.pointerMoved(2, PANEL)
  assert.equal(ctl.dismiss(), true)
  clock.advance(5000)
  assert.equal(ctl.getState().visible, false, 'still resting on the edge: stays closed')
  ctl.pointerMoved(M.EDGE_WIDTH_PX + 40, PANEL)
  ctl.pointerMoved(2, PANEL)
  clock.advance(M.OPEN_DELAY_MS)
  assert.equal(ctl.getState().visible, true)
})

test('closing with the hamburger while the pointer is far from the edge leaves hover armed', async () => {
  const { M, clock, ctl } = await make('hover')
  ctl.pointerMoved(400, PANEL)
  ctl.toggle()
  ctl.toggle()
  ctl.pointerMoved(1, PANEL)
  clock.advance(M.OPEN_DELAY_MS)
  assert.equal(ctl.getState().visible, true)
})

test('changing mode: hover from a visible panel keeps it open until the pointer leaves; hidden closes it at once; pinned always shows', async () => {
  const { M, clock, ctl } = await make('pinned')
  ctl.pointerMoved(100, PANEL)
  ctl.setMode('hover')
  assert.equal(ctl.getState().visible, true)
  clock.advance(5000)
  assert.equal(ctl.getState().visible, true, 'pointer still over the panel')
  ctl.pointerMoved(700, PANEL)
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
  ctl.toggle()
  ctl.setMode('hidden')
  assert.equal(ctl.getState().visible, false)
  ctl.setMode('pinned')
  assert.equal(ctl.getState().visible, true)
  assert.equal(ctl.getState().open, false)
  assert.equal(clock.pending(), 0)
})

test('switching modes cancels a pending open or close', async () => {
  const { M, clock, ctl } = await make('hover')
  ctl.pointerMoved(1, PANEL)
  assert.equal(clock.pending(), 1)
  ctl.setMode('hidden')
  clock.advance(M.OPEN_DELAY_MS * 3)
  assert.equal(ctl.getState().visible, false)
})

test('subscribers hear about real changes only, and a snapshot is stable between changes', async () => {
  const { ctl } = await make('hidden')
  let calls = 0
  const off = ctl.subscribe(() => { calls += 1 })
  const before = ctl.getState()
  ctl.pointerMoved(50, PANEL)
  ctl.setFocusWithin(true)
  ctl.dismiss()
  assert.equal(calls, 0)
  assert.equal(ctl.getState(), before)
  ctl.toggle()
  assert.equal(calls, 1)
  off()
  ctl.toggle()
  assert.equal(calls, 1)
})

test('dispose cancels timers', async () => {
  const { clock, ctl } = await make('hover')
  ctl.pointerMoved(1, PANEL)
  assert.equal(clock.pending(), 1)
  ctl.dispose()
  assert.equal(clock.pending(), 0)
})

test('choosing a mode while the display choice is open never leaves the choice stuck open behind a closed panel', async () => {
  const { ctl } = await make('hover')
  ctl.toggle()
  ctl.setMenuOpen(true)
  ctl.setMode('hidden')
  assert.equal(ctl.getState().visible, false)
  assert.equal(ctl.getState().menuOpen, false)
  ctl.setMode('pinned')
  ctl.setMenuOpen(true)
  ctl.setMode('hover')
  assert.equal(ctl.getState().visible, true, 'leaving pinned keeps the panel up so the change is visible')
  assert.equal(ctl.getState().menuOpen, true, 'and its choice stays open while it is up')
})

test('switching into hover with no pointer information closes by itself, it is never stuck half open', async () => {
  const { M, clock, ctl } = await make('pinned')
  ctl.setMode('hover')
  assert.equal(ctl.getState().visible, true)
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
  assert.equal(clock.pending(), 0)
})

test('hidden to hover while the panel is open from the hamburger: it stays until the pointer has left', async () => {
  const { M, clock, ctl } = await make('hidden')
  ctl.toggle()
  ctl.pointerMoved(120, PANEL)
  ctl.setMode('hover')
  assert.equal(ctl.getState().visible, true)
  assert.equal(ctl.getState().explicit, false)
  clock.advance(5000)
  assert.equal(ctl.getState().visible, true)
  ctl.pointerMoved(800, PANEL)
  clock.advance(M.CLOSE_DELAY_MS)
  assert.equal(ctl.getState().visible, false)
})

test('a panel width that is not reported keeps the last known width', async () => {
  const { M, clock, ctl } = await openedByHover()
  ctl.pointerMoved(200)
  clock.advance(M.CLOSE_DELAY_MS * 4)
  assert.equal(ctl.getState().visible, true)
})

test('hammering the mode, the hamburger and the pointer never leaks timers or breaks the invariants', async () => {
  const { M, clock, ctl } = await make('pinned')
  let seed = 12345
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  const xs = [0, 3, 9, 11, 60, 150, 231, 233, 400, 900]
  for (let i = 0; i < 600; i += 1) {
    const before = ctl.getState()
    switch (rand(9)) {
      case 0: ctl.setMode(M.SIDEBAR_MODES[rand(3)]); break
      case 1: ctl.toggle(); break
      case 2: ctl.dismiss(); break
      case 3: ctl.pageSelected(); break
      case 4: ctl.setFocusWithin(rand(2) === 0); break
      case 5: ctl.setMenuOpen(rand(2) === 0); break
      case 6: ctl.pointerLeft(); break
      case 7: ctl.pointerMoved(xs[rand(xs.length)], PANEL); break
      default: clock.advance([1, 60, 130, 360, 1000][rand(5)])
    }
    const now = ctl.getState()
    assert.ok(clock.pending() <= 1, `at most one timer is ever pending (step ${i}, ${before.mode} -> ${now.mode})`)
    assert.equal(now.visible, now.mode === 'pinned' || now.open)
    if (now.mode === 'pinned') assert.equal(now.open, false)
    if (now.explicit) assert.equal(now.open, true)
    if (now.mode !== 'pinned' && !now.open) assert.equal(now.menuOpen, false, 'a closed overlay has no open choice')
  }
  ctl.pointerLeft()
  ctl.setFocusWithin(false)
  ctl.setMenuOpen(false)
  clock.advance(10000)
  assert.equal(clock.pending(), 0)
  const end = ctl.getState()
  if (end.mode === 'hover') assert.equal(end.visible, end.explicit, 'a hover panel with nothing holding it has closed')
})

// The choice used to be a floating popover wider than the panel, so the pointer over its far
// edge counted as having left the panel (hover mode slid shut under it), it overlapped the
// header and the page, and the hamburger had a second, unlabelled chevron beside the logo.
const readSource = (rel) => require('node:fs').readFileSync(path.join(appRoot, rel), 'utf8')

test('the display choice is part of the panel: one hamburger, one labelled row, no floating popover', () => {
  const shell = readSource('src/components/SidebarShell.jsx')
  const panel = shell.indexOf('ref={panelRef}')
  assert.ok(panel > 0 && shell.indexOf('{displayChoice}') > panel, 'rendered inside the element the hover logic measures')
  assert.doesNotMatch(shell, /sidebar-options|sidebar-mode-menu|position:\s*fixed/)
  assert.equal((shell.match(/className="sidebar-toggle/g) || []).length, 1, 'one hamburger')
  assert.match(shell, /aria-expanded=\{expanded\}/)
  assert.match(shell, /aria-controls=\{pinned \? OPTIONS_ID : SIDEBAR_ID\}/)
  const css = readSource('src/styles.css')
  assert.doesNotMatch(css, /sidebar-mode-menu|sidebar-options|sidebar-rail/)
})

test('stacking: over the toolbar, under the library dialogs; slot animates; reduced motion is instant', () => {
  const css = readSource('src/styles.css')
  const zOf = (selector) => {
    const at = css.indexOf(selector)
    assert.ok(at >= 0, selector)
    return Number((css.slice(at, css.indexOf('}', at)).match(/z-index:\s*(\d+)/) || [])[1])
  }
  const panelZ = zOf(".sidebar:not([data-mode='pinned']) {")
  const toggleZ = zOf('.sidebar-toggle {')
  assert.ok(panelZ > 5, 'above the sticky toolbar (5)')
  assert.ok(toggleZ > panelZ, 'the hamburger stays clickable over the open panel')
  assert.ok(toggleZ < 50, 'under the 50 the library dialogs use')
  assert.match(css, /\.sidebar-slot \{[^}]*transition: width \.2s/, 'the content width eases between pinned and not')
  assert.match(css, /prefers-reduced-motion:reduce\)[^}]*\*,\*::before,\*::after \{ transition:none!important/, 'reduced motion turns every transition off')
  assert.match(css, /\.sidebar-display-options\[hidden\] \{ display: none; \}/)
})
