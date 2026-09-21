'use strict'
// Turns a resolved profile into what a client applies: attributes on <html> and CSS variables.
//
//   renderSpec(effective) -> { attrs:{ 'data-density':'compact', ... }, vars:{ '--ui-font-scale':'1.15', ... } }
//
// The spec is the contract. The web server writes it into the page while rendering (so nothing flashes and no
// script decides the layout), and the desktop app and native clients receive the very same spec from
// /api/prefs and apply it themselves (src/lib/profileApply.js). Only NON-default choices produce anything, so a
// person with no saved preferences renders byte for byte what the site always did.
//
// Every value here comes from a closed set or a clamped number (see prefsSchema.js); nothing a person typed
// reaches the page as text. Attribute values are still filtered to [a-z0-9.-] on the way out.
//
// The static rules below use tokens (var(--ui-*)) so a designer restyles by changing the values, not the rules.

const schema = require('./prefsSchema')

const LARGE_TEXT_SCALE = 1.25
const ASPECT_ATTR = { '2:3': '2-3', '3:4': '3-4', '1:1': '1-1', '16:9': '16-9' }
const ASPECT_VAR = { '2:3': '2/3', '3:4': '3/4', '1:1': '1/1', '16:9': '16/9' }

/** The font scale actually applied: Large text raises the floor to 125%. */
const fontScaleOf = (a, l) => (a.largeText ? Math.max(l.fontScale, LARGE_TEXT_SCALE) : l.fontScale)

function renderSpec(effective) {
  const attrs = {}
  const vars = {}
  const layout = (effective && effective.layout) || schema.DEFAULTS.layout
  const access = (effective && effective.access) || schema.DEFAULTS.access
  if (layout.density !== 'comfortable') attrs['data-density'] = layout.density
  if (layout.cardStyle !== 'classic') attrs['data-card-style'] = layout.cardStyle
  if (layout.posterAspect !== '2:3') { attrs['data-poster-aspect'] = ASPECT_ATTR[layout.posterAspect]; vars['--poster-aspect'] = ASPECT_VAR[layout.posterAspect] }
  if (layout.radius !== null && layout.radius !== undefined) {
    const r = layout.radius
    attrs['data-radius'] = 'custom'
    vars['--radius-card'] = `${r}px`
    vars['--radius-control'] = `${Math.round(r * 0.8)}px`
    vars['--radius-button'] = `${Math.round(r * 0.7)}px`
  }
  const scale = fontScaleOf(access, layout)
  if (scale !== 1) { attrs['data-font-scale'] = 'custom'; vars['--ui-font-scale'] = String(scale) }
  if (access.largeText) attrs['data-large-text'] = '1'
  if (access.reduceMotion === 'on') { attrs['data-reduce-motion'] = '1'; vars['--ui-motion'] = '0' }
  return { attrs, vars }
}

const SAFE_ATTR = /^[a-z0-9.-]{1,24}$/
const SAFE_VAR_VALUE = /^[0-9./a-z-]{1,16}$/

/** ` data-a="b" data-c="d"` for the <html> tag; '' when there is nothing to say. */
function htmlAttrs(spec) {
  return Object.keys(spec.attrs).filter((k) => /^data-[a-z-]{1,24}$/.test(k) && SAFE_ATTR.test(String(spec.attrs[k])))
    .map((k) => ` ${k}="${spec.attrs[k]}"`).join('')
}

// ---- static rules (web pages). Selectors target the shared stylesheet's classes. -------------------------
const G = '.beebo-main .grid'
const RULES = {
  'data-density=compact': `
:root[data-density=compact] ${G}{gap:10px!important}
:root[data-density=compact] .beebo-main .meta{padding:6px 8px!important}
:root[data-density=compact] .beebo-main .topbar{margin-bottom:16px;padding-bottom:14px}
@media(min-width:861px){:root[data-density=compact] ${G}{grid-template-columns:repeat(auto-fill,minmax(112px,1fr))!important}:root[data-density=compact] .beebo-main{padding:22px 28px 44px}}`,
  'data-density=spacious': `
:root[data-density=spacious] ${G}{gap:28px!important}
:root[data-density=spacious] .beebo-main .meta{padding:12px 14px!important}
:root[data-density=spacious] .beebo-main .topbar{margin-bottom:34px;padding-bottom:28px}
@media(min-width:861px){:root[data-density=spacious] ${G}{grid-template-columns:repeat(auto-fill,minmax(176px,1fr))!important}:root[data-density=spacious] .beebo-main{padding:44px 52px 72px}}`,
  'data-card-style=flat': `
:root[data-card-style=flat] .beebo-main .card{background:transparent!important;border-color:transparent!important;box-shadow:none!important}`,
  'data-card-style=outlined': `
:root[data-card-style=outlined] .beebo-main .card{background:transparent!important;border:1px solid var(--card-border)!important;box-shadow:none!important}`,
  'data-card-style=floating': `
:root[data-card-style=floating] .beebo-main .card{border-color:transparent!important;box-shadow:0 10px 30px rgba(0,0,0,.35)!important}
:root[data-card-style=floating] .beebo-main .card:hover{transform:translateY(-4px)}`,
  'data-poster-aspect': `
:root[data-poster-aspect] .beebo-main .card img,:root[data-poster-aspect] .beebo-main .card>img,:root[data-poster-aspect] .beebo-main .noposter{aspect-ratio:var(--poster-aspect)!important}`,
  'data-font-scale': `
:root[data-font-scale] body{font-size:calc(14px*var(--ui-font-scale))}
:root[data-font-scale] .beebo-main .title{font-size:calc(13px*var(--ui-font-scale))}
:root[data-font-scale] .beebo-main .sub{font-size:calc(11px*var(--ui-font-scale))}
:root[data-font-scale] .beebo-main .muted,:root[data-font-scale] .beebo-main .meta{font-size:calc(13px*var(--ui-font-scale))}
:root[data-font-scale] .beebo-nav-link{font-size:calc(14px*var(--ui-font-scale))}
:root[data-font-scale] .beebo-main .tab{font-size:calc(14px*var(--ui-font-scale))}
:root[data-font-scale] .beebo-main .topbar h2{font-size:calc(29px*var(--ui-font-scale))}
:root[data-font-scale] .beebo-main input,:root[data-font-scale] .beebo-main select,:root[data-font-scale] .beebo-main textarea{font-size:max(16px,calc(14px*var(--ui-font-scale)))}`,
  'data-reduce-motion': `
:root[data-reduce-motion="1"] *,:root[data-reduce-motion="1"] *::before,:root[data-reduce-motion="1"] *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
:root[data-reduce-motion="1"] .beebo-main .card:hover{transform:none!important}`
}

const RULE_ORDER = ['data-density=compact', 'data-density=spacious', 'data-card-style=flat', 'data-card-style=outlined', 'data-card-style=floating', 'data-poster-aspect', 'data-font-scale', 'data-reduce-motion']

/** The stylesheet text for a spec: the variables, then only the rules whose attribute is present. '' when nothing is set. */
function css(spec) {
  const attrs = spec.attrs
  const keys = Object.keys(attrs)
  if (!keys.length) return ''
  const body = Object.keys(spec.vars).filter((k) => /^--[a-z-]{3,20}$/.test(k) && SAFE_VAR_VALUE.test(spec.vars[k])).map((k) => `${k}:${spec.vars[k]};`).join('')
  const rules = RULE_ORDER.filter((key) => {
    const [name, value] = key.split('=')
    return value === undefined ? name in attrs : attrs[name] === value
  }).map((k) => RULES[k].trim())
  // Radius: more specific than a theme's own `:root[data-theme]` rule, so an explicit layout choice wins.
  const radius = attrs['data-radius'] ? `:root[data-theme][data-radius]{${['--radius-card', '--radius-control', '--radius-button'].filter((k) => spec.vars[k]).map((k) => `${k}:${spec.vars[k]};`).join('')}}` : ''
  return [body ? `:root{${body}}` : '', radius, ...rules].filter(Boolean).join('\n')
}

// ---- per-request wiring (called from theme.js and browserChrome.js) --------------------------------------

/** The profile in effect for the request being rendered; cached on the request's holder. Never throws. */
function requestProfile(holder) {
  if (!holder) return null
  if (holder.prefs) return holder.prefs
  let result = null
  try {
    if (holder.store && !holder.safe) {
      const store = require('./prefsStore')
      const { effective } = store.resolve(holder.store, holder.userId)
      result = { effective, spec: renderSpec(effective) }
    }
  } catch { result = null }
  holder.prefs = result || { effective: null, spec: { attrs: {}, vars: {} } }
  return holder.prefs
}

/** Add the layout attributes and CSS to a theme.renderInfo() result. */
function augment(info, holder) {
  const p = requestProfile(holder)
  const spec = p.spec
  const attrs = htmlAttrs(spec)
  if (attrs) info.attrs = attrs // absent when there is nothing to add, so the default render info is unchanged
  const extra = css(spec)
  if (extra) info.css = [info.css, extra].filter(Boolean).join('\n')
  return info
}

/** The web sidebar order for this request: the person's order and hidden items applied to `defaultOrder`. */
function webNav(defaultOrder) {
  try {
    const holder = require('./theme').requestScope()
    const p = requestProfile(holder)
    if (!p || !p.effective) return defaultOrder
    return schema.resolveNav(p.effective.layout.sidebar, 'web', defaultOrder)
  } catch { return defaultOrder }
}

module.exports = { LARGE_TEXT_SCALE, fontScaleOf, renderSpec, htmlAttrs, css, augment, webNav, requestProfile }
