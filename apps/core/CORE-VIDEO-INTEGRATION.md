# Core Video Integration

How the ported `party`, `webrtc`, `hub`, and `sources` modules were wired into the core
video app. Everything here is **additive** — no ported module file was changed. The three
edited files are `player/PlayerActivity.kt`, `res/layout/activity_player.xml`, and
`ui/MainActivity.kt`. The manifest needed **no** changes (see PiP below).

## 1. Watch party bound to the real player

`PlayerActivity` owns no ExoPlayer of its own — it drives a Media3 `MediaController`
(which **is** an `androidx.media3.common.Player`) connected to `PlaybackService`. That
controller is handed straight to the party controller, so the host's real play/pause/seek
is what viewers follow.

- The connected controller is published into a Compose `mutableStateOf<Player?>` (`partyPlayer`)
  the moment it connects (in `connectController`'s ready callback).
- A **"👥 Watch together"** button in the player's top bar toggles a Compose overlay
  (`R.id.partyOverlay`, a `ComposeView` in the layout, `GONE` by default).
- The overlay hosts a side-sheet (`PartySheet`, a private composable in `PlayerActivity.kt`)
  that calls the ported `rememberParty(session, player, onLoadVideo)` and drops in the ported
  `PartyScreen` whole: roster, Host/Join toggle, `AudioDelaySlider()`, and the
  movable/resizable/hideable `VideoWindow`. `onPopOut` is wired to `enterPip()`.
- **Opt-in only.** `rememberParty` returns `null` when there is no hub token, so the
  Host/Join chips are disabled. Building the controller does no network I/O; it only
  *connects* when the user taps Host/Join. Nothing touches the network on ordinary playback.
- Host drives, viewers mute + follow — all handled inside `PartyController` (unchanged).
- Lifecycle: `rememberParty`'s `DisposableEffect` stops the controller when the party
  `ComposeView` disposes (Activity destroy). The composition stays alive while the sheet is
  merely hidden, so a joined party keeps syncing behind the scenes.

## 2. Picture-in-Picture

PiP was **already implemented** in `PlayerActivity` and the manifest, so this was an
upgrade rather than a build-out:

- Manifest (unchanged, verified correct): the `.player.PlayerActivity` entry already has
  `android:supportsPictureInPicture="true"`, `android:resizeableActivity="true"`, and a
  `configChanges` list covering `screenSize|smallestScreenSize|screenLayout|orientation|…`
  so the Activity is not recreated on the PiP transition.
- Added **`setAutoEnterEnabled(...)` + `setSeamlessResizeEnabled(true)` on API 31+** in
  `buildPipParams()`, driven by the same `PipPolicy.shouldAutoEnterOnLeave(...)` rule.
- `refreshAutoEnter()` re-pushes params (so the auto-enter flag tracks live play/pause);
  it is called from `refreshPipActions()` on the events that already fire it.
- `onUserLeaveHint()` now **only** manually enters PiP on API < 31 (31+ auto-enters).
- `onPictureInPictureModeChanged()` also hides the party sheet when entering PiP.
- Surface handoff: the ExoPlayer surface lives on the `PlayerView`, which is not recreated
  across the transition, so the picture should carry over. Marked `TODO(device)` in
  `buildPipParams()` for on-device confirmation.

## 3. Remote-stream (WebRTC) render path

- A **"🖥 Stream from PC"** button in the top bar calls `startRemoteStream()`, which runs
  `WebRtcConnector.startRemoteSession(context)` (reads hub token + base URL from
  `SessionStore`, reuses the shared OkHttp client) and stores the connector in a
  `mutableStateOf<WebRtcConnector?>`.
- A second full-screen `ComposeView` (`R.id.webrtcOverlay`) hosts `RemoteStreamOverlay`:
  - Observes `connector.state` → shows Connecting / "waiting for video" / **PeerOffline** /
    **Failed(reason)** banners.
  - Observes `connector.remoteVideo`; when a `VideoTrack` arrives it `remember`s a
    `SurfaceViewRenderer` from `connector.createRenderer(context)` (init runs on the UI/compose
    thread) and hosts it via `AndroidView`.
  - `DisposableEffect(track, renderer)` calls `track.addSink(renderer)` on attach and
    `connector.releaseRenderer(renderer, track)` on dispose.
- Entry-point pauses local playback so the two video sources don't fight. Close button and
  `onDestroy` both `close()` the connector (idempotent). Marked `TODO(device)` for visual
  confirmation of the PC picture.
- Gated on a hub token — otherwise a toast points the user at Settings.

## 4. Hub sign-in + your-links (Settings)

- Added a **gear icon** to `MainActivity`'s top bar → navigates to a new `"settings"` route
  (one `composable`, no other nav rewiring).
- `SettingsScreen` (private composable in `MainActivity.kt`):
  - Hub email/password sign-in via `HubAuth.signIn(session, email, password)`, which persists
    the JWT into `SessionStore.hubToken`. Errors surface via `HubException.message`. Shows a
    "Sign out of hub" (`session.logoutHub()`) when already signed in.
  - Drops in the ported `AddSourceScreen()` for "bring your own link" sources.
- The stored `hubToken` is exactly what unlocks the watch party and the remote stream in the
  player.

## Manifest changes

**None.** The PiP attributes the task calls for were already present and correct on
`.player.PlayerActivity`, and `INTERNET`/`ACCESS_NETWORK_STATE` (used by the hub/party/webrtc
sockets) were already declared. No new permissions, features, or components were required.

## Entry points a user taps

| Where | Control | Effect |
|-------|---------|--------|
| Player top bar | 👥 Watch together | Opens the party sheet (roster, Host/Join, audio delay, video window, Pop out→PiP) |
| Player top bar | 🖥 Stream from PC | Full-screen WebRTC receiver of the home PC |
| Player (Home / auto) | — | Auto-enters PiP while playing (31+ system auto-enter, <31 manual) |
| Main screen top bar | ⚙ gear | Settings: hub sign-in + your own links |

## On-device TODOs

- `PlayerActivity.buildPipParams()` — confirm the ExoPlayer surface handoff into PiP is
  seamless (`TODO(device)`).
- `RemoteStreamOverlay` — confirm the `SurfaceViewRenderer` actually shows the PC picture
  (`TODO(device)`).
- `PlayerActivity` party `onLoadVideo` — resolving a host-switched hub video id to a playable
  stream for viewers is left as a best-effort hook (`TODO(device)`); only repositioning of the
  already-loaded item works out of the box.

## Compile risks foreseen

- **WebRTC AAR / compileSdk.** `io.github.webrtc-sdk:android:125.6422.07` is already declared
  in `app/build.gradle.kts` (mavenCentral). If its AAR manifest requires a newer `compileSdk`
  than **34**, the build will fail at manifest-merge and `compileSdk` must be bumped (36) —
  the one plausible gradle change. No code here forces it.
- **Compose-in-Views interop.** `PlayerActivity` is a View/ViewBinding Activity; the two
  `ComposeView`s rely on `AppCompatActivity` providing the ViewTree lifecycle owners (it does,
  via `setContentView`). Both start `GONE` (attached, so they compose; hidden, so no network).
- **`MediaController.setVolume` for viewer mute** — `PartyController` sets `player.volume = 0f`
  on the controller; depends on the session granting `COMMAND_SET_VOLUME` (Media3 default does).
- No nested block comments were introduced (the KDoc uses the note convention, not `/* */`).
