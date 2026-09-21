# Beebo Entertainment for macOS

Status: **builds and is checked on GitHub Actions macOS runners; not yet run on a real Mac by a
person, and not yet signed or notarized.** Signing needs the owner's Apple Developer account (see
"What the owner needs").

## What is built

`.github/workflows/mac-build.yml` (manual: Actions tab > "macOS desktop build" > Run workflow) builds
on two native runners and uploads two artifacts:

| Artifact | Runner | Contents |
|---|---|---|
| `beebo-mac-arm64` | `macos-14` (Apple Silicon) | `BeeboEntertainment-<version>-mac-arm64.dmg` and `.zip` |
| `beebo-mac-x64` | `macos-15-intel` (Intel) | `BeeboEntertainment-<version>-mac-x64.dmg` and `.zip` |

Each run: builds an LGPL ffmpeg from pinned sources (cached), makes the `.icns`, runs
`npx vite build` + `electron-builder --mac dmg zip --<arch> --publish never`, then checks the packages
exist, unzips the zip and checks ffmpeg/ffprobe, the licence file, the architecture (`lipo`), the
`Info.plist` keys and the signature, mounts the dmg, and smoke-launches the app (the media server must
log `Stream server listening` within 20 s; informational, it does not fail the run). It never
publishes a release. A universal binary is not built: two per-architecture downloads keep each app
about half the size.

Everything macOS-specific in the repo:

| File | Purpose |
|---|---|
| `desktop/apps/desktop/package.json` `build.mac` | dmg + zip, arm64 + x64, `public.app-category.video`, hardened runtime, entitlements, ffmpeg `extraResources` (`resources/ffmpeg-mac-${arch}`), `NSLocalNetworkUsageDescription` |
| `installer/mac/entitlements.mac.plist`, `entitlements.mac.inherit.plist` | hardened-runtime exceptions (below) |
| `installer/mac/build-ffmpeg-mac.sh` | builds ffmpeg/ffprobe (LGPL, VideoToolbox, OpenH264, Opus); see `THIRD_PARTY_LICENSES/FFMPEG-SETUP.md` section 8 |
| `installer/mac/make-icns.sh` | `.icns` from `resources/icons/256x256.png` with `sips` + `iconutil` (on the runner) |
| `installer/mac/afterPack.js` | ad-hoc signs an unsigned build so it can launch on Apple Silicon |
| `electron/platformPolicy.js` | the pure per-platform decisions (login item, tray icon, updates, Dock) |
| `test/mac-platform.test.js` | tests for all of the above, runnable on any OS |

To build on a Mac yourself: `cd desktop/apps/desktop && npm ci --workspaces=false`, run
`bash installer/mac/build-ffmpeg-mac.sh arm64 resources/ffmpeg-mac-arm64` (or `x86_64` /
`resources/ffmpeg-mac-x64`; needs `brew install pkgconf nasm`), `bash installer/mac/make-icns.sh`,
`npx vite build`, then `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --publish never`.

## What an unsigned build does on a customer's Mac

The CI build is signed **ad hoc** (no identity). That is enough to launch on Apple Silicon, but it is
not something Gatekeeper trusts. A dmg/zip downloaded from a browser is quarantined, and the first launch shows
"Beebo Entertainment cannot be opened because Apple cannot check it for malicious software" (macOS 15
and later: "... not opened"). Workarounds for testers, in order of friendliness:

1. Drag the app to Applications, try to open it once, then **System Settings > Privacy & Security >
   scroll down > "Open Anyway"** (macOS 15+; on macOS 14 and earlier right-click > Open works too).
2. Or remove the quarantine flag: `xattr -dr com.apple.quarantine "/Applications/Beebo Entertainment.app"`.

Do not ship this build to customers. Other visible differences of an unsigned/ad-hoc app:

- Every new build has a different ad-hoc identity, so the macOS **Keychain** prompt ("Beebo
  Entertainment wants to use your confidential information stored in ... Safe Storage") can reappear after
  each update, and secrets encrypted by the old build may need re-entry. A Developer ID signature has a
  stable identity, so this stops once signed.
- macOS asks "Do you want the application to accept incoming network connections?" (its Application
  Firewall) and, on macOS 15+, for **Local Network** access (used to find the router for UPnP). Both
  should be answered Allow: without incoming connections, phones and TVs on the same Wi-Fi cannot
  reach the library.

## What the owner needs (signing and notarization)

1. **Apple Developer Program** membership (US$99 a year), enrolled as an individual or as an
   organization (an organization needs a D-U-N-S number and takes longer). https://developer.apple.com/programs/
2. A **Developer ID Application** certificate (Certificates, Identifiers & Profiles > Certificates >
   "Developer ID Application"; create the request in Keychain Access > Certificate Assistant, download the
   `.cer`, double-click to install). Export the certificate **with its private key** from Keychain Access as
   a `.p12` with a password. (Not "Apple Development", not "Mac App Distribution": those are for other things.)
3. Notarization credentials, either:
   - an **App Store Connect API key** (Users and Access > Integrations > App Store Connect API; a
     `.p8` file, its Key ID and the Issuer ID), which suits CI best; or
   - an **Apple ID + app-specific password** (appleid.apple.com > Sign-In and Security > App-Specific
     Passwords) plus the **Team ID** (Membership details).
4. Nothing in this repo needs to change to turn signing on: hardened runtime and the entitlements are
   already configured, and electron-builder signs every Mach-O file (including the bundled
   ffmpeg/ffprobe) and notarizes when it finds the variables below.

### The exact electron-builder environment variables (electron-builder 24)

Signing (electron-builder reads these; a `.p12` can be a file path or base64 text):

```
CSC_LINK=<path to the Developer ID Application .p12, or its base64>
CSC_KEY_PASSWORD=<the .p12 password>
```

Notarization, option A (API key, recommended):

```
APPLE_API_KEY=<path to AuthKey_XXXXXXXXXX.p8>
APPLE_API_KEY_ID=<Key ID>
APPLE_API_ISSUER=<Issuer ID>
```

Notarization, option B (Apple ID):

```
APPLE_ID=<Apple ID email>
APPLE_APP_SPECIFIC_PASSWORD=<app-specific password>
APPLE_TEAM_ID=<10-character Team ID>
```

With either group present electron-builder notarizes (with `notarytool`, the successor to `altool`)
after signing and staples the ticket; without them it silently skips notarization. Then the
build is the same command as before, minus `CSC_IDENTITY_AUTO_DISCOVERY=false`:

```
npx electron-builder --mac --arm64 --publish never      # and --x64 on the Intel runner
```

To sign in CI, copy `mac-build.yml` to a release workflow, store the values above as **GitHub
Actions secrets**, pass them as `env:` on the electron-builder step, remove
`CSC_IDENTITY_AUTO_DISCOVERY: "false"`, and add a verification step:

```
codesign --verify --deep --strict --verbose=2 "Beebo Entertainment.app"
spctl --assess --type execute --verbose "Beebo Entertainment.app"     # expect: accepted, source=Notarized Developer ID
xcrun stapler validate "Beebo Entertainment.app"
```

A notarization run typically takes 2 to 15 minutes. If Apple rejects it, `xcrun notarytool log <id>`
names the unsigned/unhardened file (the usual culprits are a newly added binary that was not signed
with the hardened runtime, or a missing timestamp).

### Entitlements (why each one is there)

`installer/mac/entitlements.mac.plist` (main process) and `entitlements.mac.inherit.plist` (helpers and
the bundled ffmpeg):

- `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory`: required by Electron's V8
  under the hardened runtime.
- `com.apple.security.network.server` / `network.client`: Beebo runs a media server and calls out to
  the internet. (These only restrict a sandboxed app; Beebo is not sandboxed, so they document intent.)
- **Not** requested: camera, microphone, contacts, location, Apple Events. The karaoke and web pages
  run in the viewer's own browser, not in an embedded window of this app.
- `Info.plist`: `NSLocalNetworkUsageDescription` (the router lookup for UPnP port mapping uses
  multicast). No `NSBonjourServices`: Beebo does not advertise over Bonjour/mDNS.

The Mac App Store is a different path (sandbox, `mas` target, provisioning profile) and is not set up.
Direct download with Developer ID is what this build is for.

## What behaves differently on a Mac (and how it is guarded)

Windows-only code paths were checked one by one; the Mac decisions live in
`electron/platformPolicy.js` and are tested by `test/mac-platform.test.js`:

| Area | On macOS |
|---|---|
| Start at login | Supported through `app.setLoginItemSettings` (no path/args on Mac; the launch counts as "hidden" when macOS reports it was opened at login). Off by default until sign-in, on by default after, same as Windows. If the person disables it in System Settings > General > Login Items the Settings page says so. |
| Tray | A menu-bar icon (PNG, `electron/beebo-tray.png`; the Windows `.ico` cannot be loaded on a Mac). Closing the window hides it; clicking the Dock icon brings it back; Cmd+Q or "Quit Beebo completely" stops the server. |
| Stay awake while streaming | `powerSaveBlocker` works on macOS. The Settings note is worded for a Mac; the "open sleep settings" button is Windows-only and hidden. |
| Windows Firewall rule check (`netsh`) | Skipped: the check returns "not applicable" off Windows (already guarded, now covered by a test). |
| Router port mapping (UPnP / NAT-PMP) | Already had a macOS branch (`route -n get default`); nothing to change. Needs the Local Network permission on macOS 15+. |
| Self-updater | **Never runs the Windows installer.** See "Updates". |
| Reliability panel: power/Windows settings items | Windows-only, hidden. |
| ffmpeg | The bundled Mac build; the transcoder tries Apple's hardware H.264 encoder (`h264_videotoolbox`) first, then OpenH264. The HDR tone-mapping filters (`zscale`) are not in the Mac build, so HDR sources are converted without tone-mapping. |
| Default library folders | `~/Beebo/...` (same rule as Linux). |
| Data and logs | `~/Library/Application Support/Beebo Entertainment/` (settings, `logs/main.log`). |
| Story writer (BeeboBook) | Needs `python3` (macOS offers to install the Command Line Tools the first time). |

## Updates

Mac updates are **"download page" mode**. The Windows updater downloads an installer from
`desktop-version.json` and runs it elevated; that can never happen on a Mac. Instead:

- The tray/menu "Check for updates" reads the same `desktop-version.json` for the version number
  only, and if it is newer shows "Beebo X is available", with **Open download page** / **Later**. The page
  is `https://www.beeboentertainment.com/updates.html` unless the feed carries an optional
  `"macDownloadUrl"` (must be `https` on `beeboentertainment.com` / `www.beeboentertainment.com`, otherwise
  ignored). The person downloads the new dmg/zip and drags it over the old app in Applications.
- There is no background check, out-of-date badge or automatic install on a Mac.
- The Mac update flow does **not** need a Mac entry in the feed to work; add `macDownloadUrl` when a
  Mac download page exists, and publish the dmg/zip files next to the Windows installer (the release
  script currently only knows the `.exe`).

A true in-app update on a Mac (download, replace, relaunch) is possible later with `electron-updater`
(needs the **signed and notarized** zip plus a `latest-mac.yml` next to it; macOS refuses to swap an
unsigned app). Plan it after the first signed release; it is deliberately not part of this build.

## CI evidence so far (2026-09-21)

Run 35594231750 on branch `mac-build` (GitHub Actions, macos-14 arm64 and macos-15-intel x64):

- Confirmed: both runner labels exist; the pinned Opus, OpenH264 (commit) and FFmpeg 8.1.3 downloads
  verify; OpenH264, Opus and FFmpeg compile and link on both architectures with the configure line in
  `THIRD_PARTY_LICENSES/FFMPEG-SETUP.md` (no `--enable-gpl` / `--enable-nonfree` in the printed
  `configuration:` line).
- The run then stopped in the script's own verification: its `ffmpeg -L` licence check did not match
  because ffmpeg wraps that text across lines. Fixed afterwards (whitespace is flattened first) but
  **not re-run**: the workflow was not re-run afterwards.
- **Still needs a CI run** (never executed): the ffmpeg verification rest (encoder list, `otool -L`,
  OpenH264/VideoToolbox test encodes), `.icns` generation, `vite build`, `electron-builder --mac`
  with the ad-hoc-signing hook, the dmg/zip checks, the packaged-app smoke launch, and artifact upload.

## Not verified (no real Mac was available)

Everything below is checked on a CI runner or by reading code, not by using the app on a Mac:

- The tray/menu-bar icon look and behaviour, Dock click, Cmd+Q, login item and "opened at login"
  hidden start.
- Playback through the bundled ffmpeg with real hardware encoding (a CI VM often has no media engine, so
  the runner only proves the encoder is present; the OpenH264 test encode is real).
- The first-launch permission prompts (Local Network, incoming connections, Keychain).
- The look of the Dock/dmg icon: the only source art is 256x256, so the 512/1024 sizes are upscaled
  and soft. A 1024x1024 master at `resources/icons/1024x1024.png` is used automatically when present.
- Gatekeeper behaviour of the ad-hoc build on the newest macOS releases (described above from Apple's
  documented behaviour).
- Intel builds are compiled on a real Intel runner, but nobody has run them on an Intel Mac.
