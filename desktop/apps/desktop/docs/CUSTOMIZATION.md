# Customizing Beebo: profiles, layout packs and theme packs

This is the guide for **designers** (and for whoever pastes a ChatGPT design into the repo). Everything a person can customize
is **data**: JSON files that Beebo validates, previews and stores per person. There is no script, no CSS text, no font and
no image in any of it, so a design can be swapped, shared or thrown away without touching code.

If you only read one section, read [How a ChatGPT design drops in](#how-a-chatgpt-design-drops-in-as-a-pack).

## The pieces

| Piece | What it is | Where it lives |
| --- | --- | --- |
| **Prefs profile** | One person's saved choices: layout, view, accessibility, theme. Versioned, per user, synced to every device they sign in on. | `electron/prefsSchema.js` (shape), `electron/prefsStore.js` (storage), `electron/prefsWeb.js` (HTTP) |
| **Theme pack** | A complete set of colors (CSS variables from the registry) plus a scheme, shipped as one `.json`. | `electron/packs/theme-*.json` |
| **Layout pack** | Home shelf order and visibility, sidebar items and order, density, card style, corner radius, poster shape, text size. | `electron/packs/layout-*.json` |
| **Accessibility toggles** | *Reduce motion* and *Large text*. Personal only; a pack can never set them. | `access` section of the profile |
| **Profile file** | A single `.beebo-profile` file: export from one device or account, import on another. | Settings > Appearance (desktop), the Appearance page (website) |

Shipped defaults: themes **Dark, Light, High contrast, OLED black**; layouts **Classic, Cinematic shelves, Compact library**.
They are deliberately plain and token based. Replace them by editing the JSON files, not code.

## How the pieces combine

Per key, lowest to highest priority: **built-in defaults, household defaults (owner-set), the person's own choices**.
A person's layer is stored *sparsely*: only what they changed, so a later change to the household default reaches everyone who has
not overridden that key. Colors (preset plus overrides) are stored by the existing theme engine (`userThemes`, `/api/theme`) and
carried by the profile, so both doors keep working.

Applying a pack **copies its validated values into the person's profile** and remembers `{ id, version }` as its origin. Nothing
runs from the pack afterwards. If the person edits anything by hand the origin is dropped ("Custom layout").

## Applying it: nothing flashes

* **Website and phone web UI**: the server resolves the signed-in person's profile while rendering each page and writes
  attributes on `<html>` plus one `<style>` block. No script decides the layout. Signed-out pages show the household defaults.
* **Desktop app**: fetches the profile at start-up, applies the same attributes and variables, and caches them so the first paint
  is already right.
* **Phones and TVs (native)**: read `GET /api/prefs` on sign-in and on resume and apply the `render` block (or derive their own).

A person with nothing saved gets byte-for-byte the original page.

### The tokens (accessibility and layout)

Set by the server from the profile; restyle by changing the *values*, not the selectors (`electron/prefsRender.js`, `src/profile.css`).

| Attribute on `<html>` | Variable(s) | Comes from |
| --- | --- | --- |
| `data-density="compact\|spacious"` | (rules only) | `layout.density` (comfortable sets nothing) |
| `data-card-style="flat\|outlined\|floating"` | (rules only) | `layout.cardStyle` (classic sets nothing) |
| `data-poster-aspect="3-4\|1-1\|16-9"` | `--poster-aspect` | `layout.posterAspect` (2:3 sets nothing) |
| `data-radius="custom"` | `--radius-card`, `--radius-control` (80%), `--radius-button` (70%) | `layout.radius` (null = the theme's own) |
| `data-font-scale="custom"` | `--ui-font-scale` | `layout.fontScale` (0.85 to 1.6), raised to at least 1.25 by Large text |
| `data-large-text="1"` | (with `--ui-font-scale`) | `access.largeText` |
| `data-reduce-motion="1"` | `--ui-motion: 0` | `access.reduceMotion = "on"`; switches off animation, transition, smooth scroll and hover movement |

`access.reduceMotion` is `system` (default: follow the operating system, which the base stylesheet already honors), `on`, or `off`.

## Theme pack format

```json
{
  "format": "beebo-pack",
  "v": 1,
  "kind": "theme",
  "id": "acme.sunset",
  "name": "Sunset",
  "version": "1.0.0",
  "description": "Warm dusk colors on a deep plum background.",
  "author": { "name": "Acme Studio", "url": "https://acme.example" },
  "license": "CC-BY-4.0",
  "content": {
    "scheme": "dark",
    "themeColor": "#1a1020",
    "extends": "graphite",
    "vars": {
      "--bg": "#1a1020",
      "--panel": "#26182e",
      "--text": "#f6ecf5",
      "--card-bg": "linear-gradient(155deg,#2d1c36,#1f1326)",
      "--radius-card": "16px"
    }
  }
}
```

* `id`: lowercase letters, digits, dots, dashes (2 to 64). Reverse-domain style (`acme.sunset`) avoids clashes. `version`: `1.0.0` form.
* `scheme`: `dark` or `light`. Sets the browser's `color-scheme` (scrollbars, form controls).
* `themeColor`: `#rrggbb`, the phone browser bar. (The page's `--bg` is used when a pack sets it.)
* `extends` (optional): a built-in preset id whose values fill in anything `vars` omits. Default: `graphite` for dark, `daylight` for light.
  The shipped packs define **every** variable so they do not depend on a base.
* `vars`: only names from the registry (`electron/themeTokens.js`, listed in `docs/THEMING.md`), only these value types:
  **color** (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()`, `transparent`), **gradient** (`linear-gradient`,
  `radial-gradient` of colors, 2 to 8 stops, up to 3 layers, or `none` where allowed) and **size** (corner radius, up to 64px).
  No named colors, no `var()`, no `calc()`.
* `license` is required (CC0-1.0 or CC-BY-4.0 recommended, so Beebo can redistribute it).
* Optional `integrity`: `sha256-...` over the canonical content. Refused if the content was changed after sealing.

### Contrast (WCAG AA) and the automatic fix

The checker holds about 50 foreground/background pairs (body text, links, button text on every gradient stop, sidebar, phone tabs,
placeholders, focus ring, field borders) to **4.5:1 for text and 3:1 for icons, borders and the focus ring**; a gradient must pass at every
stop. Bundled packs must pass (High contrast passes AAA, 7:1). An imported pack that misses some is **still importable**, with a warning
that lists each failing pair, and an offer to **fix automatically**: the fixer moves only the *text* color of a failing pair (never a
background) toward white or black by the smallest amount that passes every pair that color takes part in, so the hue and feel stay.
Text that would be worse than 3:1 (`--text`, `--muted`, `--link` on the page or panels) is refused outright, so no theme can make
the app unreadable.

## Layout pack format

```json
{
  "format": "beebo-pack", "v": 1, "kind": "layout",
  "id": "acme.cozy", "name": "Cozy", "version": "1.0.0",
  "description": "Big posters, soft corners, trailers first.",
  "author": { "name": "Acme Studio" }, "license": "CC-BY-4.0",
  "content": {
    "density": "spacious",
    "cardStyle": "floating",
    "radius": 18,
    "posterAspect": "2:3",
    "fontScale": 1.05,
    "sidebar": { "mode": "hover", "order": ["movies", "tvshows"], "hidden": ["getapp", "suggest"] },
    "home": { "shelves": [ { "id": "continue", "on": true }, { "id": "trailers", "on": true }, { "id": "recent", "on": false } ] }
  }
}
```

| Key | Values |
| --- | --- |
| `density` | `compact`, `comfortable`, `spacious` |
| `cardStyle` | `classic` (the theme's own card), `flat`, `outlined`, `floating` |
| `radius` | whole number 0 to 28 (px), or `null` for the theme's own |
| `posterAspect` | `2:3`, `3:4`, `1:1`, `16:9` |
| `fontScale` | 0.85 to 1.6 in steps of 0.05 |
| `sidebar.mode` | `pinned`, `hover`, `hidden` (used by the desktop app and native clients) |
| `sidebar.order` | ids from the nav registry; ids not listed keep their default order after these |
| `sidebar.hidden` | ids from the nav registry. `appearance` (website) and `settings` (desktop) can **never** be hidden |
| `home.shelves` | rows of `{ id, on }`, ids: `continue`, `recent`, `watchlist`, `recommended`, `collections`, `trailers`; no repeats; omitted shelves are on, at the end |

Nav ids: `getstarted movies tvshows music trailers audiobooks podcasts radio photos playlists livetv continue surprise upload migrate dashboard admin users history flags converted requests school getapp suggest apikeys appearance security gamehost settings`
(each client ignores ids it does not have). The registry is `NAV_ITEMS` / `SHELF_ITEMS` in `electron/prefsSchema.js`; a pack **cannot invent** a nav entry or a home row.
Hiding a sidebar item only tidies the menu. It never changes who may open a page; every protected page is still checked on the server.

A layout pack fills the `layout` section only. It never touches accessibility, the library view, or colors.

## How a ChatGPT design drops in as a pack

ChatGPT owns the visual design; the pack format is the hand-off. The designer never edits app code.

1. **Give ChatGPT the vocabulary.** Paste the variable table from `docs/THEMING.md` and the two example packs above and ask for a
   `beebo-pack` JSON of `kind: "theme"` (and/or `"layout"`). Tell it: *colors and gradients only, values from the registry, no url(), no fonts, no images, hex or rgb() colors.*
2. **Save the answer** as `electron/packs/theme-<name>.json` (or `layout-<name>.json`). The file name is free; the `id` inside is what counts.
3. **Validate it:** `node tools/validate-pack.js electron/packs/theme-sunset.json`. It prints every reason a file is refused, and for themes
   the WCAG AA problems. Add `--fix` to write `theme-sunset.fixed.json` with the automatic contrast fix, and `--seal` to add an integrity hash.
4. **Try it without shipping:** Settings > Appearance > *Import a file...* (desktop) or *Import a file* on the website's Appearance page.
   It previews what would change, then applies. Both work with any pack file, bundled or not.
5. **Ship it:** a valid file in `electron/packs/` is offered automatically as a chip in the editor and on the website (the folder is read at start-up; a broken
   file is skipped with a log line and fails `test/prefs-packs.test.js`). Run `node --test test/prefs-packs.test.js test/css-safe.test.js`.
6. **Replacing a default** (e.g. a new "Dark"): edit the JSON, keep the `id`, raise `version`. People who applied the old one see it as a customization; a later
   update prompt can compare `origin.version`.

What ChatGPT should *not* produce, because it is refused: CSS text, `@import`, `url()` (remote or `data:`), `expression()`, fonts,
images, scripts, unknown variable names, gradients with more than 8 stops or 3 layers, and files over 256 KB.

## Import and export

* **Export**: Settings > Appearance > *Export my profile...* writes `beebo.beebo-profile` (JSON). The website has the same button. It contains
  the resolved layout, view, accessibility and theme, and **no** ids, tokens, e-mail or history.
* **Import** accepts a `.beebo-profile` or a single pack. It always shows a preview first (how many settings change; contrast warnings for
  a theme) and validates exactly as saving does. A file from a **newer** Beebo is refused with a message; an **older** version is migrated.
* API: `GET /api/prefs/export`, `POST /api/prefs/import` (add `dryRun`).

## API (one door for every client)

Bearer-token clients use `/api/prefs`; the website uses the cookie-session twin `/appearance/prefs` (same-origin JSON only). Not under `/api/v1`, never sent to webhooks.

| Call | Purpose |
| --- | --- |
| `GET /api/prefs` | `{ rev, effective, user, household, render, packs, schema }`; guests get the household defaults, read-only |
| `PATCH /api/prefs` (or `POST`) | JSON merge-patch of `{ layout?, view?, access?, theme? }`. Objects merge, lists replace, `null` returns a key to its default. Send `If-Match: <rev>` (or `ifMatch` in the body); a stale one is `409 conflict` |
| `DELETE /api/prefs?section=layout\|view\|access\|theme\|all` | reset (`POST /api/prefs/reset` also works) |
| `GET /api/prefs/export`, `POST /api/prefs/import` | profile file in and out |
| `POST /api/prefs/pack` | `{ kind, id, autoFix? }` apply a bundled pack |
| `POST /api/prefs/preview` | what a patch would look like (`attrs`, `css`, `spec`), nothing saved |
| `POST /api/prefs/theme-check` | WCAG AA findings and the fix for `{ preset, custom }` |
| `GET/PUT /api/prefs/household` | the owner's default layer (PUT: admins only) |

`view` (poster size, titles, icons, library mode and sort) is stored, synced and exported now; the desktop app keeps using its own device settings for poster size
until the device layer lands (see below).

## Safety model (why a pack cannot hurt anyone)

* A pack is **data only**: JSON, at most 256 KB, one file (no zip). Unknown keys anywhere are errors. `__proto__`, `constructor`, `prototype`, deep nesting and oversize are refused.
* Every color, gradient and size passes one gate (`electron/cssSafe.js`) **before** parsing (no `url()`, `@import`, `expression`, `javascript:`, braces, backslash escapes,
  comments, quotes, `var()`/`calc()`, non-ASCII look-alikes or control characters, `data:`/`http(s):` anywhere), then the type's grammar, and the value is
  **re-serialised** from the parsed result. The stylesheet is rebuilt from those values by code; the pack's text is never echoed.
* Names, ids and descriptions are plain text, refused if they contain control, zero-width or right-to-left override characters, and are always rendered as text.
* Stored rows are **re-validated on every read**, so a hand-edited settings file cannot inject anything. A write is all or nothing.
* **Per-user isolation**: every operation takes the acting account id; guests and invalid ids are read-only. The desktop console edits the owner's profile only.
* The Reset box on the Appearance page uses fixed inline colors and `?safe=1` shows the page with no theme and no layout changes, so no saved choice can hide the way back.
  Hiding items in the sidebar never hides Appearance or Settings.
* Account deletion purges the person's row. Backups list the new keys under "Themes, layouts and accessibility choices".

## Versioning and migrations

`v` is the schema version of a stored row or exported file (currently **1**). `MIGRATIONS[n]` in `electron/prefsSchema.js` turns version *n* into *n + 1*;
version **0** (the desktop's old flat `uiPrefs` and a `userThemes` row) is migrated today. To change the schema: add a step, raise `CURRENT_VERSION`, add the new keys to the
closed schema, and extend the tests. Old files keep working; files from the future are refused.

## What is not done yet (by design or later)

* Fonts and images in packs (phase 5: an SVG-allowlist sanitizer and `<img data:>` rendering). Packs are colors and layout only today.
* Web home shelves (the website has none yet; native apps and the profile are ready), web-side drag-and-drop editing of the sidebar (the desktop editor has it).
* The **device layer** (per-device overrides such as a TV vs a phone) and moving the desktop's own poster size / sidebar mode / table columns into the profile.
* Household `locks` (keys restricted profiles cannot change).
* Signed packs and a public registry; native (Android, TV, Roku) consumption of `render`.
* Theming the desktop app's own chrome from the profile's colors (it applies layout, text size and motion; colors still come from its own stylesheet).

## Tests

`test/prefs-schema.test.js` (schema, versioning, migrations), `test/css-safe.test.js` (sanitizer and the malicious pack corpus in `test/fixtures/packs/malicious/`),
`test/prefs-packs.test.js` (shipped packs, contrast checker and fixer, integrity), `test/prefs-store.test.js` (isolation, layers, concurrency, export/import roundtrip,
purge), `test/prefs-render.test.js` (attributes, tokens, CSS), `test/prefs-http.test.js` (end to end against a real server), `test/prefs-ipc-and-client.test.js`
(desktop IPC and renderer helpers).
