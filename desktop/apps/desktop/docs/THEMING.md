# Theming the Beebo browser site

This is the code plumbing that lets a designer change how the browser site (and the Android WebView, which
loads the same pages) looks by filling in **values**, without touching layout code. Layout and structure are
untouched; only colors, gradients and three corner radii are variable.

**Sharing and shipping themes:** a whole theme can be delivered as a validated `.json` theme pack (with contrast checking, import/export and an automatic fix), and layouts as layout packs. See `docs/CUSTOMIZATION.md`.

Everything a theme can change is one CSS custom property (`--name`) declared in the `:root` block at the top of
`electron/browserTheme.css`. The default values there are exactly the original "Midnight" look.

## The pieces

| File | Job |
| --- | --- |
| `electron/browserTheme.css` | The shared stylesheet. Its first `:root{...}` block holds every theme variable with its Midnight default. |
| `electron/themeTokens.js` | The **registry**: the one list of variable names, types, defaults and meanings. The doc below is generated from it. |
| `electron/themePresets.js` | The preset themes (`midnight`, `graphite`, `daylight`, `ember`): named sets of values. **This is the file the designer edits.** |
| `electron/theme.js` | Validation of the Custom slot, CSS generation, per-person storage, per-request application. |
| `electron/themeWeb.js` | The Appearance page (`/appearance`) and `/api/theme`. |
| `test/theme-*.test.js` | Tests, including a check that the default theme still renders exactly as before. |

## How a theme is applied

* The choice is stored **per person** (`userThemes[userId]` in the app's settings store), so one member's taste never
  changes another's screen. It follows the person to every device they sign in to. Signed-out pages (login) use Midnight.
* The server writes it while it renders the page: `<html data-theme="daylight">`, a matching `<meta name="theme-color">`,
  and one `<style>` rule after the base stylesheet. There is no script that decides the theme, so a page never flashes
  the wrong one.
* A preset is the rule `:root[data-theme="<id>"]{color-scheme:...; --var: value; ...}`. **Midnight has no rule**: it is the
  stylesheet's own defaults, so choosing it (or choosing nothing) renders the original site byte for byte.
* A preset rule is more specific than the plain `:root` defaults **and** than the phone override that swaps in a slightly
  different core palette below 860px, so a non-default preset wins at every screen size. Midnight on a phone keeps the
  original phone palette.
* `color-scheme` is set per preset (`dark` or `light`) so scrollbars, form controls and the browser's own UI match.
  It is deliberately not settable from the Custom slot.

## Adding or changing a preset (designer workflow)

1. Open `electron/themePresets.js`.
2. Change values in an existing preset, or copy one to add a new preset. A preset has an `id` (lowercase letters),
   `label`, `description`, `scheme` (`'dark'` or `'light'`), `themeColor` (the phone browser bar color) and `vars`.
3. `vars` must define **every** variable in the tables below except the two marked "follows" (they follow `--gold` until
   set). A test fails if one is missing, if a value is not valid for its type, or if a preset uses a name that does not exist.
4. Keep text readable. `test/theme-presets.test.js` checks roughly 50 foreground/background pairs (body text, links,
   button text on each gradient stop, sidebar links, phone tabs, focus ring, placeholders...) at WCAG AA: 4.5:1 for text,
   3:1 for icons, borders and the focus ring. The Daylight preset also meets 7:1 for body text and links.
5. Run `bash ../../../.github/scripts/desktop-tests.sh` from `desktop/apps/desktop`, or just `node --test test/theme-*.test.js`.
6. Open `/appearance` and pick the theme; the radio buttons preview it live before saving.

Things to know while choosing values:

* `--icon-btn-bg` and `--overlay-bg` sit on top of poster artwork and the text inside them is fixed light gray, so keep
  them dark even in a light theme.
* `--btn-secondary-bg` shares the button text color `--on-accent`, so on a light theme it needs a dark fill.
* Wherever the pages use a `paint`/`layer` variable it can be a `linear-gradient()`, `radial-gradient()`, `none`, or (paint only,
  last layer) a plain color. Gradient angles and stop positions are part of the value.
* `--panel`, `--raised` and `--purple` are kept from the original variable set but the shared stylesheet does not read
  `--raised` or `--purple` yet. Set them anyway (they are cheap) so any page that starts using them looks right.

## The Custom slot

On `/appearance`, "Custom overrides" takes lines of `--variable: value;` applied **on top of** the chosen preset. It exists so
a person can adjust a few colors, not so anyone can write CSS:

* Only variable names in the registry are accepted, and each value must match that variable's type
  (`color`, `paint`, `layer`, `size`, see the tables).
* **Colors**: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`, `rgba(r,g,b,a)`, `hsl(h,s%,l%)`, `hsla(...)`, `transparent`.
  No named colors, no `var()`, no `calc()`.
* **Gradients**: `linear-gradient([Ndeg | to side [side],] stop, stop, ...)` and `radial-gradient([circle|ellipse] [at X% Y%,] stop, ...)`.
  A stop is a color with an optional `0`, `N%` (0-100) or `Npx` (up to 4096) position. 2 to 8 stops, up to 3 layers.
* **Sizes** (corner radii): `0`, or `Npx` up to 64, or `Nrem`/`Nem` up to 4.
* Rejected outright: braces, backslashes, comment markers, angle brackets, quotes and backticks, `@`, `!`, `&`, `url()`, `image-set()`, `expression()`, `@import`, `javascript:`, `var()`, `calc()`,
  any non-ASCII or control character (look-alike letters, zero-width and right-to-left characters), a stray or doubled
  `;`, an unknown or repeated variable, and more than 4,000 characters (or 300 per value).
* The text is **never echoed into the stylesheet**. It is parsed into (name, value) pairs; the server then writes
  `:root[data-theme]{--a:v;--b:v;}` itself from the parsed, re-serialised values, and re-validates them again every time it
  renders (so a hand-edited settings file cannot inject either).
* A save is refused if it would make text unreadable: `--text`, `--muted` or `--link` against the page or panel background
  below 3:1 (when both are plain colors).

## Reset to default is always reachable

The **Reset to default** box on `/appearance` is built from fixed inline colors (no `var()`, no stylesheet classes, `all:initial`),
so no preset or custom override can hide or recolor it. It is a plain `<form method="post">`, so it works without
JavaScript. `/appearance?safe=1` renders the whole page in the default colors whatever is saved, and the box links to it:
a person who saved something unreadable can still find the way out. The API equivalent is `POST /api/theme {"reset": true}`.

## API

`GET /api/theme` (bearer token) returns the person's current choice, the preset list and this variable list.
`POST /api/theme` takes `{"theme": "daylight"}`, `{"custom": "--purple: #2a9d8f;"}`, both, or `{"reset": true}` and answers
`400 {ok:false, error, errors:[...]}` (nothing saved) on any problem. The cookie-session twin is `POST /appearance`
(JSON only, same-origin only).

## Not themed yet (be aware while designing)

* The video player page has its own stylesheet (`browserChrome.playerStyles`), and a few standalone pages (Suggest a
  Feature, some admin and print pages) are separate documents with their own CSS. They keep their current look in every theme.
* Many server-rendered pieces carry **inline** `style="...#hex..."` colors (about a hundred; e.g. status boxes, the
  Viewing privacy panel). Those do not change with a theme. The desktop A-Z index was the most visible one and is wired up
  through the `--alpha-bar-*` variables; the rest are candidates to move onto variables when the page is restyled.
* Drop shadows and the phone "More" scrim stay literal (black at low alpha reads fine on any theme).
* The Electron organizer app (`src/styles.css`) and the Android Compose theme are separate surfaces with their own colors.

## Variables

Types: **color** a color value; **paint** one to three comma-separated backgrounds (gradients or `none`, a plain color
allowed as the last); **layer** like paint but a plain color is not allowed (it is stacked above `--bg`); **size** a length.

### Core palette

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--bg` | color | `#080b14` | Page background. On phones the base stylesheet swaps in a slightly different set of core colors; a theme other than midnight replaces them on every screen size. |
| `--panel` | color | `#101c32` | Panel surface. Also the phone search box, tab and genre chips. |
| `--raised` | color | `#152540` | Raised surface. Reserved: the shared stylesheet does not read it yet, keep it a step lighter than --panel. |
| `--text` | color | `#f2f3ff` | Main text color. |
| `--muted` | color | `#acb6cf` | Secondary text: sub-titles, captions, muted labels. Also phone tab and chip text. |
| `--line` | color | `#2c3e5d` | Hairline borders: header rule, tables, tab bar, sign-in card. |
| `--purple` | color | `#7950cf` | Brand purple. Reserved: not read by the shared stylesheet yet. |
| `--gold` | color | `#d4af37` | Highlight color: focus ring, skip link, active-nav edge, the phone search icon and A-Z index. |
| `--link` | color | `#c5afff` | Link color. |

### Text on special surfaces

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--text-strong` | color | `#fff` | Strongest text: wordmark, hovered nav link and tab, phone menu button. Must be readable on --hover-bg and on the sidebar. |
| `--on-accent` | color | `#fff` | Text on accent fills: buttons, the active nav item, the active tab. Must be readable on every accent and nav-active gradient stop. |
| `--on-gold` | color | `#10121b` | Text on a --gold fill (the skip-to-content link). |
| `--soft-text` | color | `#bac8df` | Search status line and the empty-state message. |

### Page and focus

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--page-glow` | layer | `radial-gradient(ellipse at 100% 0,#162d4d 0,transparent 50%)` | Soft glow layered above --bg in the top-right corner of desktop pages. Use "none" for a flat page. |
| `--focus-ring` | color (follows `--gold`) | `var(--gold)` | Keyboard focus outline color. Follows --gold until set. Keep it at least 3:1 against --bg. |

### Sidebar and brand

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--sidebar-bg` | paint | `linear-gradient(165deg,#14294a,#0c1428 48%,#090b14)` | Desktop sidebar background. |
| `--sidebar-brand-sub` | color | `#b6c3df` | The small "ENTERTAINMENT" line under the wordmark. |
| `--sidebar-label` | color | `#94a5c4` | Section labels in the sidebar (YOUR LIBRARY, MORE FROM BEEBO). |
| `--sidebar-link` | color | `#bfcee6` | Sidebar link text. |
| `--sidebar-foot` | color | `#a0afc8` | Sidebar footer text. |
| `--sidebar-foot-strong` | color | `#d8e1f2` | Sidebar footer heading line. |
| `--sheet-bg` | paint | `linear-gradient(150deg,#23233c,#15243b)` | Phone "More" bottom sheet background. |
| `--sheet-border` | color | `#4c4862` | Phone "More" bottom sheet border. |
| `--mark-grad` | paint | `linear-gradient(145deg,#9567e8,#34568c)` | Brand mark (the "b" tile) fill. |
| `--mark-border` | color | `#b391eb` | Brand mark border. |

### Navigation states

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--hover-bg` | color | `#1b2b47` | Hover background of sidebar links and tabs. |
| `--nav-hover-border` | color | `#344568` | Hover border of sidebar links. |
| `--nav-active-grad-1` | color | `#6840b5` | Active sidebar item, gradient start (left). |
| `--nav-active-grad-2` | color | `#304d8e` | Active sidebar item, gradient end (right). |
| `--nav-active-edge` | color (follows `--gold`) | `var(--gold)` | Active sidebar item border and left edge bar. Follows --gold until set. |

### Buttons and accent

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--accent-grad-1` | color | `#7144c3` | Button gradient, start. |
| `--accent-grad-2` | color | `#355997` | Button gradient, end. |
| `--accent-border` | color | `#9776cb` | Button border. |

### Inputs and controls

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--input-bg` | color | `#0b1528` | Text field, text area and dropdown background. |
| `--control-border` | color | `#405376` | Border of fields and secondary buttons. |
| `--placeholder` | color | `#9aacc9` | Placeholder text inside fields. Keep it 4.5:1 against --input-bg. |
| `--search-bg` | color | `#101c30` | Desktop search box background. |
| `--btn-secondary-bg` | color | `#182b49` | Secondary button background. |
| `--menu-bg` | color | `#192b48` | Phone menu and close buttons: background. |
| `--menu-border` | color | `#415476` | Phone menu and close buttons: border. |

### Tabs

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--tab-border` | color | `#344768` | Desktop tab border. |
| `--tab-text` | color | `#b9c8e2` | Desktop tab text. |
| `--tab-active-bg` | color | `#60409f` | Active desktop tab background. |
| `--tab-active-border` | color | `#a888dc` | Active desktop tab border. |
| `--logout-text` | color | `#cad6eb` | Desktop "Log out" link text. |

### Cards and posters

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--card-bg` | paint | `linear-gradient(155deg,#152540,#101827)` | Poster card and sign-in card background. |
| `--card-border` | color | `#293a56` | Poster card border. |
| `--card-hover-border` | color | `#a182df` | Poster card border on hover. |
| `--poster-bg` | color | `#080d18` | Behind poster images while they load. |
| `--noposter-text` | color | `#c1afec` | Title text on the placeholder tile for a poster-less title. |
| `--noposter-bg` | paint | `radial-gradient(ellipse at 85% 0,#354b76,transparent 65%),linear-gradient(145deg,#302044,#10243f)` | Placeholder tile background for a poster-less title (a single gradient, or a color). |
| `--icon-btn-bg` | color | `#090e1dcc` | Small info and shortcut buttons on posters. These sit over artwork, so keep them dark. |
| `--icon-btn-border` | color | `#7791b866` | Border of those poster buttons. |
| `--overlay-bg` | color | `#0b1327f5` | Info overlay drawn over a poster. Its text is fixed light gray, so keep it dark. |
| `--empty-border` | color | `#425673` | Dashed border of the empty-state box. |
| `--empty-bg` | color | `#101c3277` | Empty-state box background. |

### A-Z index (desktop)

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--alpha-bar-bg` | color | `#171a21` | Desktop A-Z jump bar and side rail background. |
| `--alpha-bar-text` | color | `#eee` | Desktop A-Z letters that have titles. |
| `--alpha-bar-off` | color | `#4a4f58` | Desktop A-Z letters with no titles. |

### Phone layout (screens 860px and narrower)

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--mobilebar-bg` | paint | `linear-gradient(110deg,#211d36,#172943)` | Phone top app bar. |
| `--mobilebar-border` | color | `#343651` | Phone top app bar bottom border. |
| `--brand-eyebrow` | color | `#c7b173` | The small "BEEBO ENTERTAINMENT" line in the phone top bar. |
| `--round-btn-bg` | color | `#18253b` | Round search button in the phone top bar. |
| `--round-btn-border` | color | `#4b4c67` | Round search button border. |
| `--logout-border` | color | `#454b64` | Round log-out button border in the phone top bar. |
| `--bottomnav-bg` | color | `#182033f7` | Phone bottom tab bar background (slightly translucent). |
| `--bottomnav-border` | color | `#424258` | Phone bottom tab bar top border. |
| `--bottomnav-hover` | color | `#292b44` | Phone bottom tab hover background. |
| `--tab-selected-text` | color | `#f6d577` | Selected phone bottom tab label. |
| `--tab-selected-bg` | paint | `linear-gradient(105deg,#523975,#294572)` | Selected phone bottom tab icon pill. |
| `--tab-selected-border` | color | `#937b4c` | Selected phone bottom tab icon pill border. |
| `--phone-search-border` | color | `#596078` | Phone search box border. |
| `--chip-border` | color | `#38445f` | Phone tab and genre chip border. |
| `--chip-active-bg` | color | `#45365a` | Selected phone chip background. |
| `--chip-active-border` | color | `#c39c45` | Selected phone chip border. |
| `--chip-active-text` | color | `#f4d788` | Selected phone chip text. |
| `--alphabet-bg` | color | `#182033f5` | Phone A-Z index strip background. |
| `--alphabet-border` | color | `#354057` | Phone A-Z index strip border. |
| `--alphabet-disabled` | color | `#65718a` | A-Z index letters with no titles. |
| `--scrollbar` | color | `#66538d` | Thin scrollbar thumb on horizontally scrolling strips. |

### Corner radius

| Variable | Type | Midnight value | What it colors |
| --- | --- | --- | --- |
| `--radius-card` | size | `13px` | Corner radius of poster cards. |
| `--radius-control` | size | `10px` | Corner radius of fields and sidebar links. |
| `--radius-button` | size | `9px` | Corner radius of buttons and tabs. |

### Presets

| id | Label | Scheme | Notes |
| --- | --- | --- | --- |
| `midnight` | Midnight | dark | The original Beebo look: deep navy with purple and gold. |
| `graphite` | Graphite | dark | A neutral dark theme: charcoal greys with a quiet steel-blue accent. |
| `daylight` | Daylight | light | A light theme built for contrast: near-black text on white and pale grey, deep violet accents. |
| `ember` | Ember | dark | The dark layout with a warm accent: charcoal-brown surfaces and copper-orange highlights. |
