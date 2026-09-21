# What ships, and what does not

Every book here has a `scenes/` folder and an `anim/` folder. Almost none of it
is shipped, on purpose.

## The rule

A book's pictures reach a reader only when **both** of these are true:

1. `template.json` (and its twin in `apps/core/app/src/main/assets/beebobook/`)
   sets `"hasScenes": true`. Without it the phone never asks for an image, so
   the book reads as plain text.
2. `desktop/apps/desktop/package.json` lists that book under the `storybooks`
   entry in `build.extraResources`, e.g. `"fairytale/scenes/*.png"`. Without it
   the art stays in this repository and never enters the installer.

Getting one without the other is harmless — the app asks, the server has
nothing, the reader shows no picture and the story reads on — but it is not
what anyone wanted, so change both together.

## Where things stand

* **fairytale** — real illustrated art, one still per page, 1086x1448.
  `hasScenes` is on and it is packaged. 8.7 MB.
* **The other sixteen books** — the `scenes/` PNGs are early
  programmatically-drawn placeholders: flat shapes, small figures, a lot of
  empty sky. They are fine as a sketch and poor as a page of a picture book,
  and they sit beside the dragon art badly. `hasScenes` is off for all of them
  and they are not packaged. Turn a book on when it has art worth showing.
* **`anim/`** — a looping GIF per page, ~38 MB across the shelf. Nothing renders
  these yet: there is no GIF path in the Android reader. `/api/storybook-scene-anim`
  serves them if something ever asks, but they are deliberately NOT packaged.
  Do not add them to `extraResources` before something displays them.

## Sizes, before you add anything

The Windows installer is around 247 MB. All seventeen books' stills come to
about 19 MB and all the anim to about 38 MB. That is why this is opt-in per
book rather than a `*/scenes/*.png` wildcard.
