'use strict'
// The theme variable registry: every CSS custom property the shared browser stylesheet
// (browserTheme.css) lets a theme change.
//
// This file is the single list that four things read:
//   - the "Custom" validator (theme.js) accepts ONLY these names, with the value type given here;
//   - the preset themes (themePresets.js) must define every one of them;
//   - the Appearance page and docs/THEMING.md list them for the designer;
//   - a test proves each `default` here equals the value in browserTheme.css's :root block, and that
//     the default (midnight) theme still resolves to exactly the colors the stylesheet had before
//     theming existed.
//
// type:
//   color  a color: #rgb #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(), or "transparent"
//   paint  a CSS background: one to three comma-separated layers, each a linear-gradient()/radial-gradient() of
//          colors or "none"; the last layer may instead be a plain color
//   layer  like paint, but every layer must be a gradient or "none" (it is stacked above another background,
//          where a plain color would be invalid CSS)
//   size   a length (px/rem/em), capped small (corner radii)
//
// `derived` marks a default that is a reference to another variable rather than a literal, so the
// token follows that variable until a theme sets it (e.g. the focus ring follows --gold).

const GROUPS = [
  { id: 'core', label: 'Core palette' },
  { id: 'text', label: 'Text on special surfaces' },
  { id: 'page', label: 'Page and focus' },
  { id: 'sidebar', label: 'Sidebar and brand' },
  { id: 'nav', label: 'Navigation states' },
  { id: 'accent', label: 'Buttons and accent' },
  { id: 'controls', label: 'Inputs and controls' },
  { id: 'tabs', label: 'Tabs' },
  { id: 'cards', label: 'Cards and posters' },
  { id: 'index', label: 'A-Z index (desktop)' },
  { id: 'phone', label: 'Phone layout (screens 860px and narrower)' },
  { id: 'shape', label: 'Corner radius' }
]

const t = (name, type, def, group, desc, extra = {}) => Object.assign({ name, type, default: def, group, desc }, extra)

const TOKENS = [
  // ---- core palette (these existed before theming) -----------------------------------------------------
  t('--bg', 'color', '#080b14', 'core', 'Page background. On phones the base stylesheet swaps in a slightly different set of core colors; a theme other than midnight replaces them on every screen size.'),
  t('--panel', 'color', '#101c32', 'core', 'Panel surface. Also the phone search box, tab and genre chips.'),
  t('--raised', 'color', '#152540', 'core', 'Raised surface. Reserved: the shared stylesheet does not read it yet, keep it a step lighter than --panel.'),
  t('--text', 'color', '#f2f3ff', 'core', 'Main text color.'),
  t('--muted', 'color', '#acb6cf', 'core', 'Secondary text: sub-titles, captions, muted labels. Also phone tab and chip text.'),
  t('--line', 'color', '#2c3e5d', 'core', 'Hairline borders: header rule, tables, tab bar, sign-in card.'),
  t('--purple', 'color', '#7950cf', 'core', 'Brand purple. Reserved: not read by the shared stylesheet yet.'),
  t('--gold', 'color', '#d4af37', 'core', 'Highlight color: focus ring, skip link, active-nav edge, the phone search icon and A-Z index.'),
  t('--link', 'color', '#c5afff', 'core', 'Link color.'),
  // ---- text on special surfaces ------------------------------------------------------------------------
  t('--text-strong', 'color', '#fff', 'text', 'Strongest text: wordmark, hovered nav link and tab, phone menu button. Must be readable on --hover-bg and on the sidebar.'),
  t('--on-accent', 'color', '#fff', 'text', 'Text on accent fills: buttons, the active nav item, the active tab. Must be readable on every accent and nav-active gradient stop.'),
  t('--on-gold', 'color', '#10121b', 'text', 'Text on a --gold fill (the skip-to-content link).'),
  t('--soft-text', 'color', '#bac8df', 'text', 'Search status line and the empty-state message.'),
  // ---- page and focus ----------------------------------------------------------------------------------
  t('--page-glow', 'layer', 'radial-gradient(ellipse at 100% 0,#162d4d 0,transparent 50%)', 'page', 'Soft glow layered above --bg in the top-right corner of desktop pages. Use "none" for a flat page.'),
  t('--focus-ring', 'color', 'var(--gold)', 'page', 'Keyboard focus outline color. Follows --gold until set. Keep it at least 3:1 against --bg.', { derived: '--gold' }),
  // ---- sidebar and brand -------------------------------------------------------------------------------
  t('--sidebar-bg', 'paint', 'linear-gradient(165deg,#14294a,#0c1428 48%,#090b14)', 'sidebar', 'Desktop sidebar background.'),
  t('--sidebar-brand-sub', 'color', '#b6c3df', 'sidebar', 'The small "ENTERTAINMENT" line under the wordmark.'),
  t('--sidebar-label', 'color', '#94a5c4', 'sidebar', 'Section labels in the sidebar (YOUR LIBRARY, MORE FROM BEEBO).'),
  t('--sidebar-link', 'color', '#bfcee6', 'sidebar', 'Sidebar link text.'),
  t('--sidebar-foot', 'color', '#a0afc8', 'sidebar', 'Sidebar footer text.'),
  t('--sidebar-foot-strong', 'color', '#d8e1f2', 'sidebar', 'Sidebar footer heading line.'),
  t('--sheet-bg', 'paint', 'linear-gradient(150deg,#23233c,#15243b)', 'sidebar', 'Phone "More" bottom sheet background.'),
  t('--sheet-border', 'color', '#4c4862', 'sidebar', 'Phone "More" bottom sheet border.'),
  t('--mark-grad', 'paint', 'linear-gradient(145deg,#9567e8,#34568c)', 'sidebar', 'Brand mark (the "b" tile) fill.'),
  t('--mark-border', 'color', '#b391eb', 'sidebar', 'Brand mark border.'),
  // ---- navigation states -------------------------------------------------------------------------------
  t('--hover-bg', 'color', '#1b2b47', 'nav', 'Hover background of sidebar links and tabs.'),
  t('--nav-hover-border', 'color', '#344568', 'nav', 'Hover border of sidebar links.'),
  t('--nav-active-grad-1', 'color', '#6840b5', 'nav', 'Active sidebar item, gradient start (left).'),
  t('--nav-active-grad-2', 'color', '#304d8e', 'nav', 'Active sidebar item, gradient end (right).'),
  t('--nav-active-edge', 'color', 'var(--gold)', 'nav', 'Active sidebar item border and left edge bar. Follows --gold until set.', { derived: '--gold' }),
  // ---- buttons and accent ------------------------------------------------------------------------------
  t('--accent-grad-1', 'color', '#7144c3', 'accent', 'Button gradient, start.'),
  t('--accent-grad-2', 'color', '#355997', 'accent', 'Button gradient, end.'),
  t('--accent-border', 'color', '#9776cb', 'accent', 'Button border.'),
  // ---- inputs and controls -----------------------------------------------------------------------------
  t('--input-bg', 'color', '#0b1528', 'controls', 'Text field, text area and dropdown background.'),
  t('--control-border', 'color', '#405376', 'controls', 'Border of fields and secondary buttons.'),
  t('--placeholder', 'color', '#9aacc9', 'controls', 'Placeholder text inside fields. Keep it 4.5:1 against --input-bg.'),
  t('--search-bg', 'color', '#101c30', 'controls', 'Desktop search box background.'),
  t('--btn-secondary-bg', 'color', '#182b49', 'controls', 'Secondary button background.'),
  t('--menu-bg', 'color', '#192b48', 'controls', 'Phone menu and close buttons: background.'),
  t('--menu-border', 'color', '#415476', 'controls', 'Phone menu and close buttons: border.'),
  // ---- tabs --------------------------------------------------------------------------------------------
  t('--tab-border', 'color', '#344768', 'tabs', 'Desktop tab border.'),
  t('--tab-text', 'color', '#b9c8e2', 'tabs', 'Desktop tab text.'),
  t('--tab-active-bg', 'color', '#60409f', 'tabs', 'Active desktop tab background.'),
  t('--tab-active-border', 'color', '#a888dc', 'tabs', 'Active desktop tab border.'),
  t('--logout-text', 'color', '#cad6eb', 'tabs', 'Desktop "Log out" link text.'),
  // ---- cards and posters -------------------------------------------------------------------------------
  t('--card-bg', 'paint', 'linear-gradient(155deg,#152540,#101827)', 'cards', 'Poster card and sign-in card background.'),
  t('--card-border', 'color', '#293a56', 'cards', 'Poster card border.'),
  t('--card-hover-border', 'color', '#a182df', 'cards', 'Poster card border on hover.'),
  t('--poster-bg', 'color', '#080d18', 'cards', 'Behind poster images while they load.'),
  t('--noposter-text', 'color', '#c1afec', 'cards', 'Title text on the placeholder tile for a poster-less title.'),
  t('--noposter-bg', 'paint', 'radial-gradient(ellipse at 85% 0,#354b76,transparent 65%),linear-gradient(145deg,#302044,#10243f)', 'cards', 'Placeholder tile background for a poster-less title (a single gradient, or a color).'),
  t('--icon-btn-bg', 'color', '#090e1dcc', 'cards', 'Small info and shortcut buttons on posters. These sit over artwork, so keep them dark.'),
  t('--icon-btn-border', 'color', '#7791b866', 'cards', 'Border of those poster buttons.'),
  t('--overlay-bg', 'color', '#0b1327f5', 'cards', 'Info overlay drawn over a poster. Its text is fixed light gray, so keep it dark.'),
  t('--empty-border', 'color', '#425673', 'cards', 'Dashed border of the empty-state box.'),
  t('--empty-bg', 'color', '#101c3277', 'cards', 'Empty-state box background.'),
  // ---- A-Z index (desktop; the markup carries inline colors, the stylesheet reaches them with !important) ----
  t('--alpha-bar-bg', 'color', '#171a21', 'index', 'Desktop A-Z jump bar and side rail background.'),
  t('--alpha-bar-text', 'color', '#eee', 'index', 'Desktop A-Z letters that have titles.'),
  t('--alpha-bar-off', 'color', '#4a4f58', 'index', 'Desktop A-Z letters with no titles.'),
  // ---- phone layout ------------------------------------------------------------------------------------
  t('--mobilebar-bg', 'paint', 'linear-gradient(110deg,#211d36,#172943)', 'phone', 'Phone top app bar.'),
  t('--mobilebar-border', 'color', '#343651', 'phone', 'Phone top app bar bottom border.'),
  t('--brand-eyebrow', 'color', '#c7b173', 'phone', 'The small "BEEBO ENTERTAINMENT" line in the phone top bar.'),
  t('--round-btn-bg', 'color', '#18253b', 'phone', 'Round search button in the phone top bar.'),
  t('--round-btn-border', 'color', '#4b4c67', 'phone', 'Round search button border.'),
  t('--logout-border', 'color', '#454b64', 'phone', 'Round log-out button border in the phone top bar.'),
  t('--bottomnav-bg', 'color', '#182033f7', 'phone', 'Phone bottom tab bar background (slightly translucent).'),
  t('--bottomnav-border', 'color', '#424258', 'phone', 'Phone bottom tab bar top border.'),
  t('--bottomnav-hover', 'color', '#292b44', 'phone', 'Phone bottom tab hover background.'),
  t('--tab-selected-text', 'color', '#f6d577', 'phone', 'Selected phone bottom tab label.'),
  t('--tab-selected-bg', 'paint', 'linear-gradient(105deg,#523975,#294572)', 'phone', 'Selected phone bottom tab icon pill.'),
  t('--tab-selected-border', 'color', '#937b4c', 'phone', 'Selected phone bottom tab icon pill border.'),
  t('--phone-search-border', 'color', '#596078', 'phone', 'Phone search box border.'),
  t('--chip-border', 'color', '#38445f', 'phone', 'Phone tab and genre chip border.'),
  t('--chip-active-bg', 'color', '#45365a', 'phone', 'Selected phone chip background.'),
  t('--chip-active-border', 'color', '#c39c45', 'phone', 'Selected phone chip border.'),
  t('--chip-active-text', 'color', '#f4d788', 'phone', 'Selected phone chip text.'),
  t('--alphabet-bg', 'color', '#182033f5', 'phone', 'Phone A-Z index strip background.'),
  t('--alphabet-border', 'color', '#354057', 'phone', 'Phone A-Z index strip border.'),
  t('--alphabet-disabled', 'color', '#65718a', 'phone', 'A-Z index letters with no titles.'),
  t('--scrollbar', 'color', '#66538d', 'phone', 'Thin scrollbar thumb on horizontally scrolling strips.'),
  // ---- shape -------------------------------------------------------------------------------------------
  t('--radius-card', 'size', '13px', 'shape', 'Corner radius of poster cards.'),
  t('--radius-control', 'size', '10px', 'shape', 'Corner radius of fields and sidebar links.'),
  t('--radius-button', 'size', '9px', 'shape', 'Corner radius of buttons and tabs.')
]

const BY_NAME = new Map(TOKENS.map((tok) => [tok.name, tok]))

/** The `:root` declarations (without braces) for the registry defaults, in registry order. */
function defaultDeclarations() {
  return TOKENS.map((tok) => `${tok.name}:${tok.default}`).join(';')
}

module.exports = { TOKENS, GROUPS, BY_NAME, defaultDeclarations }
