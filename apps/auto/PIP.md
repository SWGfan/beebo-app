# Picture-in-Picture — pop the video out of the app

> **Status (16 Sep 2026): on for passenger phones and tablets only.** "Pop out" and auto-enter are
> offered only when `VideoGate.pipAllowed` is true: the device supports PiP, it is not Android
> Automotive OS (a floating window would sit over the car's own screens, outside the activity AAOS
> blanks while driving), it is not a phone projecting to Android Auto, and video is allowed. If video
> becomes blocked while floating, the PiP window shows why instead of the picture.

This adds Android system **Picture-in-Picture** (PIP): a user watching a film can
drop it into a small floating OS window and keep using the phone (or press Home)
while it keeps playing — and, because the underlying Media3 `Player` never stops,
while it stays locked to the watch-party.

PIP is the **"leave the app entirely"** mode. It is a genuine OS-level window that
floats over other apps and survives pressing Home. It is *not* the in-app
`party/VideoWindow` — that is a Compose frame you can drag/resize, and it only
exists while this app is on screen. The two are complementary:

| | Owner | Lives | Entered by |
|---|---|---|---|
| **`VideoWindow`** (in-app) | this app's Compose tree | only while the app is foreground | already there in `PartyScreen` |
| **PIP** (system) | the OS window manager | floats over other apps, survives Home | `PipController.enter(activity)` / system auto-enter |

Going into PIP does **not** touch the watch-party: the same `Player` keeps
decoding, so `PartyController` keeps emitting/applying sync beats throughout. A
host that pops out still drives the car audio; a viewer that pops out still
chases the host's timeline. PIP only changes *where the picture is drawn*.

Everything is **additive**. New file `ui/PipController.kt`; small, clearly-marked
edits to `AndroidManifest.xml` (Activity attributes), `ui/MainActivity.kt`
(overrides + one state field), and `party/PartyScreen.kt` (an optional
`onPopOut` button). **No new Gradle dependencies.**

`minSdk` is 24, so every PIP call is guarded twice: a feature check
(`PackageManager.FEATURE_PICTURE_IN_PICTURE`) and an API-level check
(`PictureInPictureParams` + `enterPictureInPictureMode` need API 26;
`setAutoEnterEnabled` + `setSourceRectHint` need API 31).

---

## 1. Files

| File | What it is |
|------|------------|
| `ui/PipController.kt` | **New.** All PIP logic: `isPipSupported`, `buildParams`, `enter`, `applyParams` (arm auto-enter / refresh actions), and a `playPauseAction` helper. Every call is API- and feature-guarded. |
| `AndroidManifest.xml` | Three attributes on the `.ui.MainActivity` activity. |
| `ui/MainActivity.kt` | `onUserLeaveHint` + `onPictureInPictureModeChanged` overrides, an `inPipMode` snapshot state, a `videoActive` flag with `setVideoActive(...)`, and a PIP-only collapse branch in `Screen()`. |
| `party/PartyScreen.kt` | Optional `onPopOut: (() -> Unit)?` param → a "Pop out" button. Null = hidden. Kept a callback so the `party` package never depends on the `ui` package. |

---

## 2. Manifest change

On the host activity (`.ui.MainActivity`) — three added attributes (there was no
existing `configChanges`, so nothing was dropped):

```diff
         <activity
             android:name=".ui.MainActivity"
             android:exported="true"
-            android:label="@string/app_name">
+            android:label="@string/app_name"
+            android:supportsPictureInPicture="true"
+            android:resizableActivity="true"
+            android:configChanges="screenSize|smallestScreenSize|screenLayout|orientation">
             <intent-filter>
```

`configChanges` lets the activity ride the resize into/out of the PIP window
without being recreated (which would tear down the player surface). If you later
add your own `configChanges`, **merge** — keep these four values.

---

## 3. `PipController` API (`ui/PipController.kt`)

A stateless `object`. Nothing here throws at the call site: unsupported device or
too-old API → logged no-op.

```kotlin
PipController.isPipSupported(context): Boolean
// SDK >= 26 AND packageManager.hasSystemFeature(FEATURE_PICTURE_IN_PICTURE)

PipController.buildParams(                       // @RequiresApi(26)
    aspect: Rational = 16:9,
    sourceRectHint: Rect? = null,                // applied only on API 31+
    actions: List<RemoteAction> = emptyList(),   // applied on 26+, system-capped
    autoEnter: Boolean = true,                   // setAutoEnterEnabled, API 31+
): PictureInPictureParams

PipController.enter(activity, aspect?, sourceRectHint?, actions?): Boolean
// Guarded by isPipSupported + SDK>=26; wraps enterPictureInPictureMode in
// runCatching (devices can refuse even when they report the feature). No-op → false.

PipController.applyParams(activity, ...)         // setPictureInPictureParams; no-op < 26
// Push params WITHOUT entering: this is how API 31+ auto-enter is armed, and how
// PIP action buttons are refreshed (e.g. flip Play↔Pause) while already floating.

PipController.playPauseAction(context, iconResId, title, pendingIntent): RemoteAction
// @RequiresApi(26). Build one PIP button; point the PendingIntent at a receiver
// that calls player.play()/pause().  (nice-to-have — see TODO(device))
```

### API-level guards in one place

| API call | Minimum | Guard |
|---|---|---|
| `hasSystemFeature(FEATURE_PICTURE_IN_PICTURE)` | 24 (feature const) | `isPipSupported` (also checks SDK ≥ 26) |
| `enterPictureInPictureMode(params)`, `PictureInPictureParams`, `RemoteAction` | 26 | `Build.VERSION.SDK_INT` ≥ 26 checks + `@RequiresApi(26)` |
| `setAutoEnterEnabled`, `setSourceRectHint` | 31 | `if (SDK_INT >= Build.VERSION_CODES.S)` inside `buildParams` |

---

## 4. `MainActivity` overrides added

```kotlin
private val inPipMode = mutableStateOf(false)     // Compose reads this to collapse UI
@Volatile private var videoActive = false          // "a film is playing"

fun setVideoActive(active: Boolean) {              // call from the player wiring
    videoActive = active
    PipController.applyParams(this, autoEnter = active)   // arms API 31+ auto-enter
}

override fun onUserLeaveHint() {                   // Home pressed
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S &&   // 31+ auto-enters itself
        videoActive && PipController.isPipSupported(this)) {
        PipController.enter(this)
    }
}

override fun onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    inPipMode.value = isInPictureInPictureMode
}
```

Two ways in, so both eras behave the same:

- **API 31+** — `setAutoEnterEnabled(true)` (armed by `setVideoActive`) makes the
  system auto-enter PIP on Home. No `onUserLeaveHint` needed there; it is skipped
  by the `< S` guard so we never double-enter.
- **API 26–30** — `onUserLeaveHint` enters manually when a film is playing.

And the collapse — inside `Screen()`, before the normal settings UI:

```kotlin
val inPip by inPipMode
if (inPip) {
    Surface(Modifier.fillMaxSize(), color = Color.Black) {
        // ONLY the video surface belongs here — no roster, sliders, or buttons.
        // PlayerView(player) once a player is wired.
    }
    return
}
```

The branch sits *after* all the `remember { … }` state, so flipping in and out of
PIP does not reset typed input.

---

## 5. The "Pop out" affordance (`party/PartyScreen.kt`)

`PartyScreen` gained one optional param:

```kotlin
fun PartyScreen(
    …,
    onPopOut: (() -> Unit)? = null,   // non-null → shows a "Pop out" button
)
```

It is a **callback**, not a `PipController` reference, so the `party` package
still has zero dependency on the `ui` package. The button renders only when
`onPopOut != null`. Wire it from the (already-documented) watch-party insertion
point in `MainActivity.Screen()`:

```kotlin
com.beeboentertainment.auto.party.PartyScreen(
    prefs = prefs,
    deviceName = prefs.userName.ifBlank { android.os.Build.MODEL },
    controller = party,
    videoContent = { /* PlayerView(player) */ },
    onPopOut = if (PipController.isPipSupported(this@MainActivity)) {
        { PipController.enter(this@MainActivity) }
    } else null,
)

// And arm auto-enter / the onUserLeaveHint flag from the player:
player.addListener(object : Player.Listener {
    override fun onIsPlayingChanged(isPlaying: Boolean) = setVideoActive(isPlaying)
})
```

---

## 6. Device TODOs (cannot be verified without hardware)

All marked `TODO(device)` in the source:

- **Surface handoff** (`PipController` + `Screen()` collapse) — confirm the
  ExoPlayer/PlayerView `SurfaceView` stays attached across the enter/exit
  transition. Some OEMs briefly detach it and the picture blanks; if so, keep a
  single `PlayerView` instance and re-attach it rather than recomposing a new one.
- **Source-rect hint** (`buildParams`) — pass the video's real on-screen `Rect`
  so the shrink animates from the right place; measure the actual bounds on device.
- **Auto-enter tracking** (`setVideoActive`) — drive it from the real player's
  `isPlaying` so PIP arms only while a film plays.
- **Actions** (`playPauseAction` / `applyParams`) — the Play/Pause buttons are a
  nice-to-have: wire a `BroadcastReceiver` to the `PendingIntent`, and re-push via
  `applyParams` on state change so the button swaps Play↔Pause live. Verify the
  floating window refreshes on the target OS.
- **Drift on resume** — after a long spell in PIP, confirm `PartyController`'s
  sync re-locks cleanly when the app returns to full screen.
