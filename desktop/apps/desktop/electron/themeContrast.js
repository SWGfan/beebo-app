'use strict'
// WCAG contrast checker and automatic fixer for themes and theme packs.
//
// PAIRS is the list of foreground/background variable pairs that carry text (or must stay visible: focus
// ring, field border). It is the same list test/theme-presets.test.js holds every preset to, so a pack that
// passes here looks like a preset that passes there. 4.5 = WCAG AA body text; 3 = large text, icons and
// control boundaries. A gradient background must pass at every stop.
//
//   check(baseId, vars, {level})  -> { failures:[{fg,bg,ratio,min,what}], checked }
//   autoFix(baseId, vars, {level}) -> { vars, changes:[{name,from,to}], remaining:[failure] }
//
// autoFix only ever moves the FOREGROUND variable of a failing pair (text, links, borders, focus ring): it
// blends that color toward white or black by the smallest amount that satisfies every pair it takes part
// in, so the hue and feel are kept. Backgrounds are never touched: the designer's surfaces stay as drawn.

const theme = require('./theme')
const { BY_NAME } = require('./themeTokens')

const PAIRS = Object.freeze([
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
  ['--gold', '--alphabet-bg', 4.5, 'A-Z index letters'],
  ['--alphabet-disabled', '--alphabet-bg', 3, 'A-Z index letters with no titles'],
  ['--alpha-bar-text', '--alpha-bar-bg', 4.5, 'desktop A-Z letters'],
  ['--alpha-bar-off', '--alpha-bar-bg', 3, 'desktop A-Z letters with no titles'],
  ['--gold', '--bg', 3, 'focus ring on the page'],
  ['--gold', '--panel', 3, 'focus ring on panels'],
  ['--focus-ring', '--bg', 3, 'focus ring (as set)'],
  ['--control-border', '--bg', 3, 'field boundary']
])

const COLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi

/** Value of a variable for base preset + overrides, following one level of `var(--other)`. */
function resolve(baseId, vars, name) {
  let v = theme.effectiveValue(baseId, vars, name)
  if (typeof v === 'string' && /^var\(--[a-z0-9-]+\)$/.test(v)) v = theme.effectiveValue(baseId, vars, v.slice(4, -1))
  return v
}

/** Every plain color in a value (a gradient yields one per stop), as [r,g,b]. Alpha is ignored. */
function colorsIn(value) {
  const out = []
  for (const text of String(value || '').match(COLOR_RE) || []) {
    const rgb = theme.toRgb(text)
    if (rgb) out.push(rgb)
  }
  return out
}

function ratio(a, b) {
  const [hi, lo] = [theme.luminance(a), theme.luminance(b)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

const scaled = (min, level) => (level === 'AAA' && min >= 4.5 ? 7 : min)
const hex = (rgb) => '#' + rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')

function check(baseId, vars, { level = 'AA' } = {}) {
  const failures = []
  let checked = 0
  for (const [fg, bg, min0, what] of PAIRS) {
    const min = scaled(min0, level)
    const fgs = colorsIn(resolve(baseId, vars, fg))
    const bgs = colorsIn(resolve(baseId, vars, bg))
    if (!fgs.length || !bgs.length) continue
    checked++
    let worst = Infinity
    for (const f of fgs) for (const b of bgs) worst = Math.min(worst, ratio(f, b))
    if (worst < min) failures.push({ fg, bg, ratio: Math.round(worst * 100) / 100, min, what })
  }
  return { failures, checked }
}

/** Smallest blend of `from` toward `to` (0..1) at which `ok(color)` holds; null if even `to` fails. */
function blendUntil(from, to, ok) {
  const mix = (t) => from.map((c, i) => Math.round(c + (to[i] - c) * t))
  if (!ok(to)) return null
  if (ok(from)) return from
  let lo = 0
  let hi = 1
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    if (ok(mix(mid))) hi = mid; else lo = mid
  }
  return mix(hi)
}

function autoFix(baseId, vars, { level = 'AA' } = {}) {
  const work = Object.assign({}, vars)
  const changes = []
  for (let round = 0; round < 4; round++) {
    const { failures } = check(baseId, work, { level })
    if (!failures.length) break
    let moved = false
    const targets = [...new Set(failures.map((f) => f.fg))]
    for (const fgName of targets) {
      // A derived variable (the focus ring follows --gold) is fixed by moving the variable it follows.
      const token = BY_NAME.get(fgName)
      const target = token && token.derived && !Object.prototype.hasOwnProperty.call(work, fgName) ? token.derived : fgName
      const cur = colorsIn(resolve(baseId, work, target))[0]
      if (!cur) continue
      // Every pair this variable takes part in must hold, not just the one that failed.
      const names = new Set([fgName, target])
      const rules = PAIRS.filter(([fg]) => names.has(fg)).map(([, bg, min]) => ({ bgs: colorsIn(resolve(baseId, work, bg)), min: scaled(min, level) }))
      const ok = (c) => rules.every((r) => !r.bgs.length || r.bgs.every((b) => ratio(c, b) >= r.min))
      const score = (c) => Math.min(...rules.filter((r) => r.bgs.length).map((r) => Math.min(...r.bgs.map((b) => ratio(c, b) / r.min))))
      const white = [255, 255, 255]
      const black = [0, 0, 0]
      const extreme = score(white) >= score(black) ? white : black
      const fixed = blendUntil(cur, extreme, ok)
      if (!fixed) continue
      const to = hex(fixed)
      if (work[target] !== to) {
        changes.push({ name: target, from: work[target] || String(resolve(baseId, work, target)), to })
        work[target] = to
        moved = true
      }
    }
    if (!moved) break
  }
  const fixedVars = {}
  for (const c of changes) fixedVars[c.name] = work[c.name] // last write per name wins
  const seen = new Set()
  const finalChanges = changes.filter((c) => !seen.has(c.name) && seen.add(c.name)).map((c) => ({ name: c.name, from: c.from, to: work[c.name] }))
  return { vars: work, changed: fixedVars, changes: finalChanges, remaining: check(baseId, work, { level }).failures }
}

module.exports = { PAIRS, check, autoFix, colorsIn, resolve, ratio }
