# Beebo Entertainment

Beebo is a self-hosted media system: a desktop app (and a headless Docker server) that
runs on your own computer, indexes your own movies, TV, music, photos and audiobooks, and
streams them to your phone, TV, car and browser. Nothing is uploaded to a media cloud; your
files stay on your machine.

Website and downloads: <https://www.beeboentertainment.com>

> **Licence status:** the source is published for transparency and community review. No
> open-source licence has been granted yet. All rights are reserved by Beebo Entertainment
> until a licence is chosen. See [NOTICE.md](NOTICE.md).

## What is in this repository

```
desktop/apps/desktop/   The Beebo server and desktop app (Electron + Node + React, Windows first).
                        Also runs headless in Docker (headless/, docker/).
desktop/apps/viewer/    The small viewer app family members install.
apps/core/              Android phone/TV app (Kotlin, Jetpack Compose, Media3). Flavors: web, play, amazon.
apps/auto/              Android Auto media app (audio in the car).
apps/apple/             tvOS / iOS client (SwiftUI, BeeboKit package).
apps/roku/              Roku channel (BrightScript + SceneGraph).
apps/smarttv/           Samsung Tizen / LG webOS client (plain web app).
apps/xbox/              Xbox app (UWP WebView2 shell around the shared TV web app).
packaging/              Package-manager files: winget, Scoop, Chocolatey, Homebrew, Flatpak, Snap, AUR, Docker/NAS stores.
docs/                   Feature and platform notes (parental controls, macOS, Fire TV, voice, sound quality, ...).
.github/                CI, dependency and supply-chain automation.
```

**Not in this repository (on purpose):** Beebo's cloud services (accounts, licensing,
payments, the relay and its hosting, the coordination hub) and all deployment material.
The apps talk to those services over public HTTPS endpoints such as `login.beebo.tv`, but
their code is private. Everything needed to run your own home server, and to build and test
the clients, is here. Some comments and documents refer to private files (for example
`worker/...` paths or design notes under `docs/`); those references point at material that
is not published.

## Features and honest status

| Area | What it does | Status |
|---|---|---|
| Home media server (Windows desktop app) | Scans your folders, matches titles with TMDB metadata, streams with on-the-fly HLS conversion (ffmpeg), users and profiles, parental controls, subtitles, playlists, music, photos, audiobooks | Shipping; this is the primary product |
| Headless server (Docker) | The same server without a window, for NAS boxes, Raspberry Pi and Linux servers (amd64 and arm64) | Built and smoke-tested in CI; image not published to a registry yet |
| Web viewer / PWA | Installable web app served by your own server (works on iPhone and any browser) | Working; see [docs/PWA-INSTALL.md](docs/PWA-INSTALL.md) |
| Android phone/TV app | Browse and play from your server, watch together, picture-in-picture, downloads, Cast | Working; web (sideload), Play-style and Amazon-style flavors build. Not published on Google Play yet |
| Android Auto app | Browse and search your library on the car's media screen; audio only (Android Auto gives media apps no video surface) | Built and unit-tested in CI; see [apps/auto/README.md](apps/auto/README.md) |
| Away from home | Peer-to-peer WebRTC first; optional relay when a direct path is impossible | Direct path works; the relay is a hosted Beebo service (closed source) |
| Jellyfin-compatible API mode | Lets Jellyfin client apps talk to a Beebo server (off by default) | Implemented from public API docs; limited coverage, see [the plan](desktop/apps/desktop/docs/JELLYFIN-COMPAT-PLAN.md) |
| Switch-to-Beebo importer | Brings watched marks, ratings and playlists from Plex, Jellyfin, Emby, Kodi, Letterboxd | Implemented with dry run and undo |
| Live TV / DVR | Your own SiliconDust HDHomeRun tuner only; Beebo supplies no channels | Implemented, see [LIVE-TV.md](desktop/apps/desktop/docs/LIVE-TV.md) |
| Public API and webhooks | Bearer-token API and signed webhooks | Implemented, see [PUBLIC-API.md](desktop/apps/desktop/docs/PUBLIC-API.md) |
| macOS build | dmg/zip for Apple Silicon and Intel | Builds on CI runners only; never run on a real Mac, unsigned. See [docs/MACOS.md](docs/MACOS.md) |
| Linux build | AppImage and .deb | Built on CI; package-manager files are drafts. See [packaging/](packaging/README.md) |
| Apple TV / iPhone / iPad app | SwiftUI client | Compiles and runs in simulators on CI; **never run on a real device** |
| Roku channel | Lint, logic tests, sideload zip | Checked off-device only; **never run on a real Roku** |
| Samsung / LG TV app | Tizen and webOS staging | Exercised in desktop Chrome against a mock server; **never run on a real TV** |
| Amazon Fire TV | Runs the Android app | Plan and checklist only; **not tested on a Fire device**. See [docs/FIRE-TV.md](docs/FIRE-TV.md) |
| Xbox One / Series X\|S app | UWP shell around the shared TV web app, MSIX packaging | Written; the JavaScript side is tested, the C# shell has **never been compiled or run on a real Xbox**. See [docs/XBOX.md](docs/XBOX.md) |

## Build and run

### Desktop app and server (Node 24 recommended)

```sh
cd desktop/apps/desktop
npm ci --workspaces=false      # this app's own lockfile
npm run dev                    # Vite + Electron
```

Metadata comes from TMDB. Copy `.env.example` to `.env` and add your own key, or paste it
into the app's Settings. Windows installers are built with `npm run build` (electron-builder);
ffmpeg binaries are not committed, see
[THIRD_PARTY_LICENSES/FFMPEG-SETUP.md](desktop/apps/desktop/THIRD_PARTY_LICENSES/FFMPEG-SETUP.md).

### Headless server in Docker

```sh
cd desktop/apps/desktop
docker build -f docker/Dockerfile -t beebo-server .
```

Run options, volumes, secrets and the first-run setup code are in
[desktop/apps/desktop/docker/README.md](desktop/apps/desktop/docker/README.md).

### Android apps

```sh
cd apps/core        # or apps/auto
./gradlew testDebugUnitTest     # flavors: see .github/scripts/android-unit-tests.sh
```

You need JDK 17 and the Android SDK (`local.properties` with `sdk.dir`, git-ignored).
Release signing reads a git-ignored `keystore.properties`; without it the release build is
signed with the debug key and is only good for sideloading. No signing material is stored in
this repository.

### Apple, Roku, smart-TV clients

See [apps/apple/README.md](apps/apple/README.md), [apps/roku/README.md](apps/roku/README.md),
[apps/smarttv/README.md](apps/smarttv/README.md) and [apps/xbox/README.md](apps/xbox/README.md).

## Continuous integration

Workflows in `.github/workflows/` (all actions pinned to commit SHAs, read-only tokens,
no secrets, nothing is deployed or published):

| Workflow | When | What it does |
|---|---|---|
| CI | push / PR to `main` | Android unit tests (core, auto) and the desktop test suite plus renderer build, only for the parts that changed; **CI OK** is the single status to require |
| Headless Docker | pushes touching the server | Builds the image (amd64, arm64) and smoke-tests it; never pushes an image |
| Roku channel / smarttv-build | pushes touching those apps | Lint, tests, staging |
| Apple client build | manual, or `apple-client` branch | swift test and simulator builds on macOS runners |
| Linux / macOS desktop build | manual | AppImage, deb, dmg, zip as workflow artifacts (unsigned) |
| Xbox build | manual | Tests the shared TV app, builds the Store upload package and a throwaway-signed sideload package |
| Packaging validate | changes to `packaging/` | Lints the package-manager files |
| Secret scan, CodeQL, Dependency review, SBOM, Workflow lint | PRs / push / manual | Supply-chain checks, see [docs/SUPPLY-CHAIN-SECURITY.md](docs/SUPPLY-CHAIN-SECURITY.md) |

The desktop suite runs each `test/*.test.js` file in its own process
(`.github/scripts/desktop-tests.sh`). Two files are skipped as known failures
(`computer-gallery`, `storybook-runtime`) and are printed as warnings on every run. A few
end-to-end tests exercise Beebo's private cloud Worker, which is not in this repository;
they detect its absence and skip themselves.

## Security

Please report vulnerabilities privately to **security@beeboentertainment.com**; see
[SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.

## Contributing

Bug reports, questions and ideas are welcome through GitHub Issues. Because no licence has
been chosen yet, please open an issue to discuss a change before sending a pull request; we
may not be able to merge outside code until the licensing question is settled. Every
pull request must keep the CI checks green and follow the checklist in
[.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md). Never include secrets,
keys or real user data.

## Third-party software

See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
