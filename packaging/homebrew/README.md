# Homebrew cask (macOS): DRAFT, do not publish

Status: **draft. There is no macOS build.** `desktop/apps/desktop/package.json` has no `mac` target and nothing in `.github/workflows` builds one. The cask is a template
with guessed asset names and placeholder checksums, so that the shape is ready when a mac build exists. It was not run through `brew audit` (no Homebrew, no Ruby on the Windows PC this was prepared on).

## What must exist first

1. A macOS build: add a `mac` target (`dmg`, arm64 and x64) to electron-builder, built on a macOS runner, with a fixed `mac.artifactName`
   (the cask assumes `BeeboEntertainment-<version>-arm64.dmg` and `...-x64.dmg`).
2. **Code-signed with an Apple Developer ID and notarised.** This is the decisive point. Homebrew's Acceptable Casks page
   (https://docs.brew.sh/Acceptable-Casks, read 2026-09-21) says macOS software must pass Homebrew's Gatekeeper checks and must not require Gatekeeper or SIP to be disabled or bypassed.
   An unsigned or un-notarised build is therefore not acceptable in the main `homebrew/cask`. (An Apple Developer account is 99 USD a year; the notarisation step is part of electron-builder's mac config.)
3. Published on the GitHub release, plus the SHA-256 of each dmg.

## Which cask repository

| Where | Requirements | Verdict |
| --- | --- | --- |
| `Homebrew/homebrew-cask` (the default tap) | Passes Gatekeeper (signed + notarised); "notable" software (the docs refer to shared notability metrics and allow exceptions for established maintainers or substantial public interest); `brew audit --new --cask` and `brew style` clean; PR reviewed by maintainers. Casks are for GUI apps that upstream ships prebuilt, which this is. | Realistic only after the app has real users. Notability thresholds are **not** given numerically in the docs. |
| Your own tap, e.g. `SWGfan/homebrew-beebo` | A GitHub repository named `homebrew-<name>` with a `Casks/` folder. No review, no notability test. The Gatekeeper rule applies to Homebrew's official taps; users of an unsigned app still get macOS's own "unidentified developer" warning. | **Recommended first step.** |

Users of a tap: `brew tap SWGfan/beebo && brew install --cask beebo-entertainment` (or `brew install --cask SWGfan/beebo/beebo-entertainment`).

## Steps once the mac build exists (owner)

1. Create the repository `SWGfan/homebrew-beebo`, add `Casks/beebo-entertainment.rb` from this folder with real `sha256` values and asset names.
2. On a Mac with Homebrew: `brew style --fix Casks/beebo-entertainment.rb`, `brew audit --new --cask ./Casks/beebo-entertainment.rb`, `brew install --cask ./Casks/beebo-entertainment.rb`, then `brew uninstall --zap --cask beebo-entertainment` (check the `zap` paths are right; they are guesses from the bundle id `com.beeboentertainment.desktop`).
3. Later releases: `brew bump-cask-pr` works for the official tap; for your own tap use a scheduled `brew livecheck` GitHub Action.
4. To move to the official tap: open a PR to https://github.com/Homebrew/homebrew-cask following its CONTRIBUTING guide (about 1 to several days of review when the audit is clean; not verified).

## Fields to check

`desc`, `name`, `homepage`, `depends_on macos` (`>= :catalina` matches Electron 31's minimum; check what the build really supports), `app` name (electron-builder uses the product name, `Beebo Entertainment.app`), the `zap` paths, and `auto_updates`
(left out: the in-app updater is Windows-only, `electron/desktopUpdater.js`, so on macOS Homebrew would be the updater).
