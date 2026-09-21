# Beebo Entertainment for Apple (tvOS, iPhone, iPad)

A SwiftUI client for a person's own Beebo server. One codebase, two app targets (`BeeboTV`, `BeeboiOS`), one
Swift Package (`BeeboKit`) holding every piece of logic that can be tested without a screen.

Status: version 0.1.0, **nothing here has run on a real device**. CI proves the package compiles and its unit tests
pass on macOS, both app targets compile for the tvOS and iOS simulators without signing, and a simulator smoke run
launches each app against a mock server, renders the main screens and plays an HLS stream. Nobody has yet pressed a
button in it. See "What is verified" and "Top risks".

## Layout

```
apps/apple/
  Package.swift              BeeboKit (Foundation only; builds on macOS, iOS, tvOS)
  Sources/BeeboKit/          API client, models, server address rules, playback planning, WebVTT parser,
                             paging, pairing state machine, TV link, session/settings stores, deep links
  Tests/BeeboKitTests/       XCTest suites (run by `swift test`)
  project.yml                XcodeGen spec: targets BeeboTV (tvOS 16+) and BeeboiOS (iOS 16+)
  App/Shared/                SwiftUI code used by both targets
    Theme.swift              every colour, font, spacing and size lives here; restyle here only
    AppConfig.swift          feature switch for phone pairing, device name, version text
  App/tvOS, App/iOS/         asset catalogs (placeholder icons) - Info.plist is generated
  Resources/PrivacyInfo.xcprivacy
  tools/make_placeholder_assets.py   regenerates the placeholder icons and launch art
../../.github/workflows/apple-build.yml
```

The Xcode project is generated, not committed (`*.xcodeproj` and the two `Info.plist` files are git-ignored).

## Build

On a Mac with Xcode 16 or newer:

```
cd apps/apple
brew install xcodegen
xcodegen generate
open Beebo.xcodeproj          # schemes: BeeboTV, BeeboiOS
swift test                     # BeeboKit unit tests, no simulator needed
```

Without a Mac, push to the `apple-client` branch (or run the "Apple client build" workflow by hand). It runs on
`macos-26` (Xcode 26.6): `swift test`, then `xcodebuild build` for `BeeboTV` and `BeeboiOS` with
`CODE_SIGNING_ALLOWED=NO`, then a simulator smoke run per platform (see "What is verified"). To look at the app
locally without a Mac's server, `node tools/mock-server/server.js` serves a demo library (login `demo` / `demo`).

## What the app does

- **Sign in.** Server address, username, password (`POST /api/login`, the same call the Android app makes).
  `192.168.1.20`, `my-pc.local`, `nick.home.beebo.tv` all work; the app picks http for local addresses and adds the
  default port 47811. Deep link `beebo://connect?server=...` pre-fills the address.
- **Home.** Continue Watching and Recently Added rows (`/api/v1/continue`, `/api/v1/library/recently-added`).
- **Movies and TV Shows.** Grids paged from the server (`/api/v1/library/movies|tvshows?limit=60&offset=`), loading the
  next page as you approach the end, so a 1,300 show library never loads at once. Search uses the same routes with `q=`.
- **Detail.** Backdrop, synopsis, year, runtime, rating, Play or Resume, Start over, and for shows season chips and an
  episode list with watched marks and progress (`/api/tvshows/<key>/episodes`).
- **Playback.** `AVPlayerViewController` on the server's transcoded HLS stream (see below), progress reporting every
  10 seconds and on pause/stop (`/api/watch-session`, `/api/progress`), resume, and automatic next episode
  (`/api/upnext`).
- **Audio and subtitles.** tvOS: "Audio" and "Subtitles" menus in the transport bar. iOS: a menu button top right.
  Server-side audio tracks are switched by restarting the stream at the same position. Text subtitles are fetched as
  WebVTT and drawn by the app; picture subtitles (PGS) are burned into the stream (needs a restart, labelled in the menu).
  Anything AVFoundation itself exposes as a media selection group is also honoured by preferred language.
- **Settings.** Quality (best, 1080p, 720p, 480p), preferred audio and subtitle language, sign out.
- **Accessibility.** Text styles throughout (Dynamic Type), VoiceOver labels and hints on cards, buttons and fields,
  Dark and Light appearance through semantic colours, Siri Remote focus through the standard SwiftUI focus engine.

## The server contract in use

| Purpose | Route | Notes |
|---|---|---|
| Identify server | `GET /api/ping` | `app` is `beeboentertainment` (older builds `movieapp`) |
| Sign in | `POST /api/login` | `{username, password}` -> `{token, user}`; token lasts 365 days |
| Check session | `GET /api/me` | 401 signs the app out |
| Library (paged) | `GET /api/v1/library/movies`, `/tvshows`, `/recently-added` | account token works on `/api/v1`; `limit`, `offset`, `q` |
| Continue Watching | `GET /api/v1/continue` | 403 `history_private` is treated as empty |
| Episodes | `GET /api/tvshows/<key>/episodes` | not in v1, so this one is the app-facing route |
| Up next | `GET /api/upnext?kind=tv&id=` | |
| Playback plan | `GET /api/playback/info?kind=&id=` | qualities, audio tracks, subtitle tracks, transcoder state |
| Start stream | `POST /api/playback/start` | `{kind, id, quality, audio?, burnSubtitle?}` -> `{url:"/hls/<ticket>/index.m3u8"}` |
| Stop stream | `POST /api/playback/stop` | `{ticket}` |
| History | `POST /api/watch-session`, `POST /api/progress` | same calls as the Android app |
| Posters | `/media/poster/<id>.jpg` | no token needed; backdrops are absolute TMDB https URLs |

The client never asks for `/file` or `/tvfile`: AVPlayer cannot open Matroska, and `playbackRules.js` treats MKV as
"fine" for other clients. `/api/playback/start` always yields H.264 + AAC in MPEG-TS pieces behind a signed ticket in
the path, so the player needs no auth header. Quality tops out at 1080p because that is what the server offers.

## Away from home and phone sign-in

- `<name>.beebo.tv` is a Worker page that signs a browser in and then tunnels over WebRTC to the house. It is not a
  media server, so plain HTTP to it returns a page, not the API. The app says so if someone types one.
- The token the TV pairing flow returns (`POST /tvpair/poll`, a 12-hour `viewer` token) cannot be used against the home
  server's API directly (that needs the host agent's key). The owner approved a desktop route that exchanges it:
  `POST <serverBase>/api/viewer-session` with `Authorization: Bearer <viewer token>` (optional `{deviceName}`) ->
  `{token, user, expiresAt, server}`. That exchange is the single function `ViewerSessionService.exchange` in
  `Sources/BeeboKit/ViewerSession.swift`; `PairedSignIn.complete` tries each candidate server and stops at the first answer.
- Candidate servers, in order: the address last typed on this device (http then https for a LAN address), then
  `https://<name>.home.beebo.tv:47811` (`docs/HOME-ADDRESS.md`: real certificate, needs the router to forward 47811).
  The viewer token is never sent over plain http to a non-LAN address (enforced in code and unit tested) and is dropped
  right after the exchange; only the returned bearer is stored, in the Keychain. A 404 (older server) falls back to the
  typed sign-in with a message; 401/403/429 are shown as one plain message.
- tvOS shows the code and a QR code ("Sign in with your phone"); the iPhone "Link a TV" screen (Settings, or the
  `beebo://pair?code=ABCD-EFGH` link) signs in to the beebo.tv account, looks the code up, and approves or denies it.
  `AppConfig.phonePairingEnabled` is `true`. Until the Worker has `BEEBO_TVPAIR_ENABLED=1` (`/tvpair/*` answers 404) the
  TV silently falls back to the typed sign-in.
- **Not supported: streaming through the WebRTC tunnel.** Away from home the app works only if the home server is
  reachable over https at its `home.beebo.tv` address. Tunnel access remains a follow-up.
- Unverified: `/api/viewer-session` did not exist when this was written, so its response shape is taken from the
  contract I was given, not from running server code.

## Privacy, network security, App Review facts

- No analytics, no advertising identifiers, no third-party SDKs, no tracking. The privacy manifest declares no tracking,
  no tracking domains, no collected data types, and one required-reason API: UserDefaults (`CA92.1`), used for the
  app's own settings. Nothing else in the app touches file timestamps, boot time, disk space or active keyboards.
- App Transport Security: only `NSAllowsLocalNetworking` (no `NSAllowsArbitraryLoads`). Non-local addresses must be
  https. `NSLocalNetworkUsageDescription` is set; `NSBonjourServices` is not (nothing browses Bonjour).
- **Accounts.** The app signs in to an account that already exists on the person's own server. It has no sign-up, so
  Apple's "account deletion inside the app" rule does not apply. Say so in the review notes.
- **Payments.** No in-app purchase, subscription or price anywhere. The only wording about paid services is
  "Beebo services are managed at beebo.tv." with no link or button. Whether even that sentence is acceptable in an iOS or
  tvOS app is a question for App Review and a lawyer (the Android build has a `PaymentsGuardTest` for the same reason).
  One string in the iPhone-only Link a TV flow mentions the account being inactive ("Manage your account at beebo.tv").
- Content: the app plays what the owner put on their own server. There is no user-generated content shared between
  people. Comparable, already approved apps: Plex, Infuse, Jellyfin clients.

## What is verified (CI, macOS runner)

- `swift test`: every BeeboKit suite passes (the workflow log prints the count).
- `xcodebuild build` for `BeeboTV` (tvOS Simulator SDK) and `BeeboiOS` (iOS Simulator SDK), Debug, signing off.
- **Simulator smoke** (`simulator-smoke` job, both platforms): boots a tvOS and an iPhone simulator, installs the Debug
  build, starts `tools/mock-server` (a Node stand-in that speaks the routes above, plus an ffmpeg-made 20 second
  H.264/AAC MPEG-TS HLS stream laid out like `hlsTranscoder.js` output) and launches the app with debug-only
  environment switches (`DebugLaunch.swift`, compiled out of Release) to sign in, open each tab, open a movie and a show,
  and play the stream. It uploads screenshots as the `screenshots-tvOS` and `screenshots-iOS` artifacts. This showed on
  both simulators: sign-in over plain http to a loopback address works with only `NSAllowsLocalNetworking`, the
  Continue Watching, Recently Added, grid, detail and settings screens render, and AVPlayer decodes and plays the HLS
  stream (video and timecode visible in the screenshot).
- The built bundle contains `PrivacyInfo.xcprivacy` and the Info.plist keys (printed in the job log).

Not verified by anything: any interaction (focus movement, remote gestures, taps, keyboard entry), Siri Remote behaviour,
the Local Network permission prompt (the simulator does not raise it for loopback), a private LAN address, the real
server's HLS output (the mock imitates it), Keychain behaviour on a real Apple TV, the transport bar menus, subtitle
overlay placement, memory while scrolling many posters, the pairing screens against the live Worker, and
`/api/viewer-session` against a real server.

## Top risks, in the order I would test them

1. **AVPlayer and the server's HLS.** The playlist is a single VOD variant (`#EXT-X-VERSION:3`, 4 second `.ts` pieces,
   `EXT-X-INDEPENDENT-SEGMENTS`, no `CODECS` attribute, no master playlist). AVPlayer normally copes, but check: start
   time (the first piece waits on ffmpeg), seeking far ahead (the server restarts ffmpeg), HDR and 10-bit sources (the
   server tone-maps only when its encoder supports it), and 5.1 sources (server re-encodes audio to stereo AAC at
   128 to 192 kbps). Keep-alive null packets the server sends while a piece is prepared should be ignored by AVPlayer.
2. **Cleartext HTTP to an IP address on the LAN.** `NSAllowsLocalNetworking` should cover it for URLSession. There are
   reports that AVFoundation media loads need `NSAllowsArbitraryLoadsForMedia` instead. If a real device refuses the HLS
   URL with an ATS error, that key is the fallback, and it needs an App Review justification. The simulator smoke run
   played HLS from `http://127.0.0.1` with only `NSAllowsLocalNetworking`, which is encouraging but is a loopback
   address, not a private LAN address on a device.
3. **Local Network permission.** First contact with a LAN address raises the system prompt. If the person taps Don't
   Allow, requests fail with "Can't reach the server"; the message mentions the setting. Test denial and re-enabling.
4. **Focus and layout on tvOS.** Cards use `.buttonStyle(.card)`; the poster rows, season chips, and the sign-in form
   were never focused by a person. Long overview text is not focusable, so a very long synopsis can trap the scroll.
5. **Subtitles.** WebVTT is drawn in `AVPlayerViewController.contentOverlayView`; on iOS the system controls can cover
   it. AVFoundation cannot side-load a subtitle file into an HLS item, which is why the app draws them itself.
6. **Session lifetime.** The account token lasts a year. Server restarts that rotate `apiTokenSecret` sign everyone out;
   the app returns to the sign-in screen with a message.
7. **Server-side conversion capacity.** The server converts at most two videos at once by default. A busy answer is
   shown as text; the app does not queue.

## Owner action list for Apple

1. Enrol in the Apple Developer Program (individual or organisation; an organisation needs a D-U-N-S number).
2. Tell me the **Team ID** (10 characters, Membership page). It goes in `DEVELOPMENT_TEAM` for both targets.
3. Confirm the **bundle identifier**. The placeholder is `com.beeboentertainment.apple` for both platforms (one
   universal purchase record). Register it under Certificates, Identifiers and Profiles, capabilities: none needed.
4. In App Store Connect create one **app record** with both iOS and tvOS platforms added (same bundle id), name,
   primary language, SKU, category (Entertainment), free price.
5. Provide: privacy policy URL, support URL, marketing text, keywords, screenshots (iPhone 6.9 inch and 6.5 inch, iPad
   13 inch, Apple TV 1920x1080 or 3840x2160), app icon art (replace the placeholders, see below), age rating answers.
6. App Privacy questionnaire: "Data Not Collected" is accurate for this build; confirm against your legal advice.
7. Signing: let Xcode manage it (Automatic) or create an Apple Distribution certificate and App Store profiles. The
   project contains no identities, profiles or team ids.
8. Replace placeholder art: `App/iOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png` (1024x1024, no alpha) and the
   tvOS layered icon and top shelf images (sizes are in the file names, see `tools/make_placeholder_assets.py`).
9. Decide the App Review notes text (below) and whether to keep the "managed at beebo.tv" sentence.

## TestFlight and App Store checklist

1. On a Mac: set `DEVELOPMENT_TEAM`, `xcodegen generate`, build and run on a real Apple TV and iPhone against a real
   server. Work through "Top risks".
2. Bump `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml`. Archive each scheme (Product > Archive).
3. Validate and upload from the Organizer (or `xcodebuild -exportArchive` with an `ExportOptions.plist`).
4. In App Store Connect, wait for processing, answer the export-compliance question (the app uses only Apple's TLS:
   "uses standard encryption, exempt"), add internal testers, then external testers (external needs Beta App Review and
   a demo account or instructions).
5. Review information: a sign-in that works. Apple reviewers cannot reach a home server, so provide a **publicly
   reachable demo Beebo server** with a demo library of public-domain films and a demo username and password, or a
   screen recording. This is the single most likely cause of a first rejection.
6. Submit for review with the notes below.

Suggested App Review notes: "Beebo is a free companion app for a person's own Beebo media server (comparable to
Plex or Jellyfin clients). It contains no content of its own and no in-app purchases, subscriptions or sign-up: users
sign in to an account that already exists on their own server, so there is no account creation and no account deletion
flow. Demo server: address, username, password below."

Risk notes for review: guideline 4.2 (minimum functionality: fine, it is a full client), 3.1.1 (no digital goods sold
in app, no links to buy), 5.1.1 (no data collected, credentials are stored only in the Keychain on the device),
2.1 (needs a reachable demo server), and the local-network permission text.
