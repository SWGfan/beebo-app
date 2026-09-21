# Accessibility (desktop app)

Target: **WCAG 2.2 level AA** for the Beebo Entertainment desktop app, on the screens listed below.
This page is the checklist to run before a release, the keyboard map, and an honest list of what is
not done yet. Translation is covered in [I18N.md](I18N.md).

Screens covered so far: the sidebar and window frame, the Movies / TV Shows toolbar and poster
grid, the movie details page, Settings (top level and Language), Get Started and the Connection
Doctor. Everything else still needs the same pass (see "Known gaps").

## What is in place

| Area | What it does | Where |
| --- | --- | --- |
| Skip link | First Tab stop; jumps past the sidebar to the page heading. Visible only on focus. | `components/SkipLink.jsx`, `a11y.css` |
| Landmarks | `<nav aria-label="Main navigation">`, `<main id="main-content">`, the page is a labelled region on the details screen. | `App.jsx`, `MovieDetail.jsx` |
| Current page | Sidebar button has `aria-current="page"`; window title follows the page ("Movies - Beebo Entertainment"). | `App.jsx` |
| Live announcements | A polite and an assertive hidden live region. Page changes, the library result count ("1,204 movies"), scanning, language changes, "Saved" and Get Started progress are announced. | `lib/announcer.js`, `Movies.jsx`, `TVShows.jsx` |
| Poster grid keyboard | One Tab stop per grid (roving tabindex), arrow keys move by on-screen position across A-Z sections and at any poster size or zoom, Home / End, Ctrl+Home / Ctrl+End, PageUp / PageDown, Enter or Space opens. | `lib/gridNav.js` |
| Toolbar keyboard | View tabs, genre chips and the A-Z bar are groups with a single Tab stop; Left / Right (and Up / Down) move, Home / End jump. The tabs are toggle buttons with `aria-pressed`. | `LibraryControls.jsx`, `lib/gridNav.js` |
| Esc / Enter | Esc clears the library search box; Esc closes menus, dialogs and the details page (back); Enter runs the focused button or opens the focused card; Enter in the "search any site" box searches. Focus returns to the card you opened after leaving the details page. | `Movies.jsx`, `useBackKeys.js`, `useFocusTrap.js` |
| Dialogs | What's new and the log-out confirmation are native `<dialog>` (focus trapped, Esc closes, focus restored). The Connection Doctor is `role="dialog" aria-modal` with a focus trap and focus restore. | `WhatsNewDialog.jsx`, `ConfirmDialog.jsx`, `ConnectionDoctor.jsx` |
| Names for icon buttons | The emoji buttons on posters (play, description, artwork, delete...) have `aria-label`s; the icon-only close and menu buttons too. | `Movies.jsx`, `WhatsNewDialog.jsx` |
| Labels on fields | Search boxes, folder fields, TMDB key, sign-in fields have real labels; errors use `role="alert"`; status text `role="status"`. | `Movies.jsx`, `Settings.jsx`, `GetStarted.jsx` |
| Focus rings | 3px gold ring (`--focus`, 8-9:1 on every surface) on every control; the sidebar and poster cards use an inset / offset ring so nothing clips it. | `styles.css`, `a11y.css` |
| Contrast | Theme tokens and the pairs used on the screens above are at or over 4.5:1 (text) and 3:1 (focus ring), checked by a test. Fixed: the "No poster" placeholder (was 2.6:1). | `lib/contrast.js`, `test/a11y-helpers.test.js` |
| Reduced motion | `prefers-reduced-motion` stops transitions, animations, smooth scrolling and the hover lift. | `a11y.css` |
| Zoom / reflow | At 200% zoom (about 640 x 360 CSS px) the pinned toolbar stops pinning so content is not covered; rows wrap; the poster grid drops to fewer columns; down to 320 CSS px wide there is no sideways scroll on the framed screens. | `a11y.css` |
| Target size | The A-Z buttons are at least 24 x 24 px. | `a11y.css` |
| High contrast | `forced-colors: active` keeps focus and selection visible. | `a11y.css` |
| Language / direction | `<html lang>` and `dir` follow the chosen language. | `lib/i18nApp.js` |

## Keyboard map

| Key | Where | Does |
| --- | --- | --- |
| Tab / Shift+Tab | everywhere | Next / previous control. The poster grid is one stop. |
| First Tab, Enter | window | "Skip to main content". |
| Arrow keys, Home, End, PageUp, PageDown | poster grid | Move between posters. |
| Left / Right, Home, End | view tabs, genre chips, A-Z bar | Move within the group. |
| Enter or Space | poster card | Open the details page. |
| Esc | details page | Back to the grid. |
| Esc | search box, View options, menus, dialogs | Clear / close. |
| A-Z (letter key) | Movies, All / By Release Date | Jump to that letter (existing). |
| Alt+plus / Alt+minus, Alt or Ctrl + wheel | poster grid | Poster size (existing). |
| Alt+1 ... Alt+7 | Movies / TV Shows | Library view (existing). |

## Release checklist

Run through it with the keyboard only, then again with NVDA (free) or Narrator.

1. **Tab order.** From a fresh start press Tab: skip link, sidebar, then the page. Nothing skipped, nothing trapped, nothing invisible.
2. **Focus visible** everywhere, including inside the sidebar, on poster cards, in dialogs and on the details page.
3. **Grid.** On Movies: Tab lands on one poster; arrows move between posters (also across A-Z headings and after changing poster size with Alt+plus); Enter opens; Esc returns focus to the same poster.
4. **Every control has a name.** Icon buttons read their purpose, not "button" or an emoji name. Inputs read their label.
5. **Announcements.** Switching pages, typing in the search box (result count), Rescan, and saving a setting are spoken once, not repeated.
6. **Dialogs.** Log out, What's new, Connection Doctor: focus moves in, Tab stays in, Esc closes, focus returns to the opener.
7. **Language.** Settings > Language: pick each language; the sidebar, toolbar and details page change at once; screen reader switches voice (`lang` attribute).
8. **Contrast.** `node --test test/a11y-helpers.test.js` passes. New colours: check with `src/lib/contrast.js` (4.5:1 for text, 3:1 for icons, borders, focus).
9. **Zoom.** Set Windows text scaling to 200% and browser zoom (Ctrl+plus) to 200%: no clipped text, no horizontal scroll on a framed screen, toolbar scrolls away.
10. **Reduced motion.** Windows > Accessibility > Visual effects > Animation effects off: no movement on hover, sidebar or page changes.
11. **Windows high contrast** (Alt+Left Shift+Print Screen): everything readable, focus and selected states visible.
12. **No colour-only meaning.** Errors have words or an icon, not just red; selected tabs have `aria-pressed`.

## Adding to a screen

- Use real elements: `<button>`, `<a>`, `<label htmlFor>`, headings in order (`h2` page title, `h3` sections).
- Icon-only control: give it `aria-label` (translated with `t()`), and mark the icon `aria-hidden`.
- Poster-like list: give each card the class `poster-card` (use `posterCardProps`) and the grid keys work automatically.
- Toolbar of buttons: `data-rove="horizontal"` on the container and `data-rove-item` on each button.
- Something changes without focus moving: `announce(t('...'))` from `lib/announcer.js`; `{ assertive: true }` only for errors.
- New modal: prefer `<dialog>` + `showModal()`; otherwise `useFocusTrap`.
- Keep colours to the theme tokens; new ones must pass `contrastRatio`.

## Known gaps

Not done, in rough order of importance:

- **Other screens** have not had this pass: sign-in, Upload, Admin, Dashboard, Users, Watch History, Flags, Converted, Missing Files, Switch to Beebo (migration wizard), Audiobooks, Live TV, Phone Backups, Playlists, BeeboSchool, Home Game Server, Account security, and every panel inside Settings below the top level.
- **Movies / TV Shows pop-up windows** (fix the match, review a USB folder, find TV in Movies, clean up names, actor view) are plain `div`s: no `role="dialog"`, no focus trap, no Esc.
- **Library table and shelves** (`LibraryTable`, `LibraryShelves`) have their own keyboard handling that has not been reviewed against the grid pattern (`role="grid"` semantics, header sort announcements).
- **Small targets.** In the Compact and Mini poster sizes the overlay buttons on posters are smaller than 24 x 24 px (they are hidden until hover or focus).
- **Inline colours.** Contrast is checked for the theme tokens and the pairs on the covered screens, not for every inline `style={{ color }}` in the app (for example the age-rating chips, whose colour comes from the rating).
- **Automated checks.** There is no jsdom or browser test library in this repo, so the DOM wiring (`installGridNav`, dialogs) is covered by pure-function tests plus the manual checklist above, not by rendering tests. No axe run yet.
- **Screen-reader testing** with NVDA / Narrator was not part of this change; the checklist above is what to run.
- **Right-to-left.** The direction switch and a few shared rules exist, but no right-to-left language is shipped and most screens use physical `left` / `right` in inline styles; expect visual glitches until those move to logical properties.
- **Web pages and phone apps** (served by `streamServer.js`, Android, TV) are separate and not covered here.
- **Drag and drop** (Upload) has no keyboard alternative on the drop zone besides the Choose files button; not re-verified.
