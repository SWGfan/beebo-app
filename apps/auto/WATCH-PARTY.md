# Watch party — phone/tablet multi-screen sync

> **Status (16 Sep 2026): switched on, parked-only.** `MainActivity` now wires it: a Beebo account
> sign-in (the app had the hub client but no screen that called it, so `Prefs.hubToken` was always
> empty), a host player (a `MediaController` on `PlaybackService`) and a viewer `ExoPlayer`
> (`ui/PartyPlayers.kt`). Every picture goes through `drive/VideoGate.kt`:
>
> - **Android Automotive OS:** video only while `CarUxRestrictions.isRequiresDistractionOptimization()`
>   is false; unknown counts as blocked. The activity has no `distractionOptimized` meta-data, so AAOS
>   also blanks it while driving, and the viewer pauses in `onPause`.
> - **Phone projecting to Android Auto** (`CarConnection` = PROJECTION): never shows video; it can host (audio).
> - **Other phones/tablets:** video after an "I'm a passenger" confirmation, once per app session.
>
> Fixed on the way: outgoing envelopes had no `"type"` (the Json skips defaults), so the hub dropped
> every control/sync/bye; a role switch let the old socket's late close kill the new one; a refused
> sign-in (4001) retried forever; buffering on the host paused viewers; viewers obeyed anyone, not just
> the host; late joiners never learned the title (sync beats now carry `videoId`); entering PiP disposed
> the party. The sections below are the original design notes.

This adds the phone/tablet side of a "car watch party": several devices in one
car play the same film, kept in lock-step by the hub's room protocol. One device
**hosts** (its existing MediaSession feeds the car speakers, exactly like any
media app); the others are **viewers** that show muted video and chase the host's
timeline. A per-device **audio-delay** trim compensates for the car's Bluetooth
audio latency so a passenger's picture lines up with the sound, and a floating,
movable/resizable/hideable **video window** hosts the passenger's picture.

All new code lives under `com.beeboentertainment.auto.party`. Everything is **additive** —
the only edits outside that package are new fields in `data/Prefs.kt` and a
commented insertion point in `ui/MainActivity.kt`. **No new Gradle dependencies.**

---

## 1. Files

| File | What it is |
|------|------------|
| `party/RoomModels.kt` | Wire DTOs + the `RoomEvent` / `RoomConnection` / `RoomRole` / `RoomMember` types the app consumes. |
| `party/RoomClient.kt` | OkHttp WebSocket wrapper to `/room`, modelled on `webrtc/SignalingClient.kt`. Reconnect with backoff. |
| `party/PartyController.kt` | The sync brain: ties `RoomClient` to a Media3 `Player`. Emits/applies control + sync. Applies the audio-delay offset. Exposes `PartyState`. |
| `party/AudioDelaySlider.kt` | Compose lip-sync trim: slider ±500ms, ±10ms nudges, reset, helper text. |
| `party/VideoWindow.kt` | Compose floating video frame: drag-move, corner-resize, hide toggle, geometry persisted. |
| `party/PartyScreen.kt` | Ties it together (roster, Host/Join toggle, slider, window) + `rememberParty(...)` factory. |

---

## 2. Prefs additions (`data/Prefs.kt`)

Additive, same pattern as the existing `hubToken` / `userSources` strings:

```kotlin
var audioDelayMs: Int          // default 0, clamped to AUDIO_DELAY_MIN_MS..AUDIO_DELAY_MAX_MS (-1000..1000)
var partyRole: String?         // "host" / "viewer" / null (last role used)
var videoWindow: String?       // JSON {x,y,w,h,hidden} for the overlay; owned by VideoWindow
```

New key constants: `KEY_AUDIO_DELAY_MS`, `KEY_PARTY_ROLE`, `KEY_VIDEO_WINDOW`, plus
public `AUDIO_DELAY_MIN_MS` / `AUDIO_DELAY_MAX_MS`. `audioDelayMs` is stored as an
`Int` and clamped on write so a stray value can never send the player somewhere
absurd.

---

## 3. The room protocol

WebSocket: `wss://<hub>/room?name=<deviceName>&role=<host|viewer>` with the header
`Authorization: Bearer <hubJWT>` on the upgrade, where `hubJWT` is `Prefs.hubToken`
(the token from `HubClient` login). The token never goes in the URL, because URLs
end up in proxy and tunnel logs; the hub still accepts the old `?token=` form so
older installs keep working. The URL is
built from `HubClient.HUB_BASE_URL`, so pointing that constant at a staging host
moves the room with it.

- **On connect** the hub sends `{"type":"roster","you":"<id>","members":[{id,name,role,joinedAt}]}`.
- **Membership**: `{"type":"member-joined","member":{…}}`, `{"type":"member-left","id":…}`.
- **Control** (drive playback): send
  `{"type":"control","action":"play|pause|seek|load","positionMs":<n>,"videoId":"<id>"}`.
  The hub fans it out to the OTHER devices as the same object plus `"from":"<id>"`;
  you never receive your own echo.
- **Sync** (host drift beat): `{"type":"sync","positionMs":<n>,"playing":<bool>}`,
  received by viewers.
- **Leave**: `{"type":"bye"}` before closing (optional; `RoomClient.leave()` sends it).

`RoomClient` is transport-only: it decodes these envelopes onto `RoomEvent` and
re-emits them on a `SharedFlow`, and tracks the socket lifecycle on a
`StateFlow<RoomConnection>`. It reuses `Http.client(trustAnyCert)` (same pool/TLS
as the rest of the app) and reconnects with exponential backoff (1s → 30s),
keeping the device name and role it first joined with.

### `RoomClient` public API

```kotlin
class RoomClient(hubJwt: String, trustAnyCert: Boolean = false, scope: CoroutineScope = …)
val events: SharedFlow<RoomEvent>
val connection: StateFlow<RoomConnection>
val memberId: String                                   // our own id, from the roster
fun connect(deviceName: String, role: RoomRole)
fun sendControl(action: String, positionMs: Long, videoId: String? = null): Boolean
fun sendSync(positionMs: Long, playing: Boolean): Boolean
fun leave()                                            // sends bye, closes, stops reconnecting
```

---

## 4. `PartyController` — the sync brain

```kotlin
class PartyController(
    player: Player,                                    // androidx.media3.common.Player
    prefs: Prefs,
    room: RoomClient,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    onLoadVideo: ((videoId: String) -> Unit)? = null,  // viewer resolves videoId -> stream
)
val state: StateFlow<PartyState>                       // Disconnected | Connected | Hosting | Following
fun start(deviceName: String, role: RoomRole)
fun stop()                                             // leaves room, restores viewer volume
```

- **Host**: adds a `Player.Listener` and emits `control` on `onIsPlayingChanged`
  (play/pause), `onPositionDiscontinuity(REASON_SEEK)` (seek), and
  `onMediaItemTransition` (load, carrying the new `mediaId` as `videoId`). It also
  emits a `sync` beat every **3s**.
- **Viewer**: applies incoming `control` (play/pause/seek/load) and, on each `sync`
  beat, computes the target position and **seeks only if drift exceeds ~250ms**
  (`DRIFT_THRESHOLD_MS`) so playback stays smooth. `load` calls `onLoadVideo`.

`Player` is thread-confined to its application looper, so everything that touches
it runs on `scope` (the main dispatcher by default); `Player.Listener` callbacks
arrive there too. Socket events are only ever read inside collectors on `scope`.

### Audio-delay sign convention

The car plays the host's audio over Bluetooth (A2DP), which buffers — the sound
you HEAR at wall-clock `T` is content the host emitted roughly `audioDelayMs`
earlier. So the passenger's muted video must show that same slightly-earlier
content to line up with the lips. The controller applies:

```
effectiveTarget = syncedPositionMs - Prefs.audioDelayMs
```

- **Positive `audioDelayMs`** = "car audio is late" ⇒ the video is pulled **back**
  by that many ms so the picture waits for the delayed sound.
- **Negative** ⇒ the video is pushed **ahead**.

The offset is applied to every position handed to the local player — both control
seeks and sync corrections (`withAudioDelay(...)`) — so the two never diverge. On
a `sync` beat the controller also adds the wall-clock time elapsed since the beat
arrived (the host's clock kept moving), then applies the offset. Only viewers ever
apply it; the host hears nothing local.

The user tunes `Prefs.audioDelayMs` live with `AudioDelaySlider`; because
`PartyController` reads the pref fresh on each seek/sync, a drag re-aligns the
picture within a beat or two with no extra wiring.

### `PartyState`

```kotlin
sealed class PartyState {
    object Disconnected
    data class Connected(you, roster)   // in room, no role driving
    data class Hosting(you, roster)     // drives playback; car plays this device's audio
    data class Following(you, roster)   // muted, chasing the host
}
```

---

## 5. Viewer-mute wiring (single audio source)

Sync only works against **one** audio source, so only the HOST outputs audio; its
existing `MediaSession` in `PlaybackService` already routes to the car speakers
like any media app — **unchanged**. Every VIEWER must be silent.

`PartyController` mutes the viewer's player where it takes over it, in `start(...)`:

```kotlin
if (role == RoomRole.VIEWER) {
    savedVolume = player.volume
    player.volume = 0f          // silence the local track; frames keep decoding
}
```

`stop()` restores `savedVolume`. Muting via `volume = 0f` (rather than
abandoning audio focus) is deliberate: the transport keeps running so video stays
decoded and seekable, and we do not fight the host's app for audio focus. If a
viewer uses a **separate** local `ExoPlayer` (the normal case — the car's session
player belongs to the host), you can additionally build that player **without**
audio focus handling: `ExoPlayer.Builder(ctx).setAudioAttributes(attrs, /* handleAudioFocus = */ false)`.
Do **not** change `PlaybackService`'s player — that is the host's audio path.

> Note: `PlaybackService` runs audio-only on Android Auto by design (a media app
> never gets a Surface). The watch-party video window is a **phone/tablet** UI
> (mirrored or on the passenger's own screen), not an Android Auto surface.

---

## 6. `MainActivity` insertion point

`ui/MainActivity.kt` `Screen()` has a **commented** insertion block at the end of
its `Column` (search for "Watch party (car multi-screen) insertion point"). It is
left commented so this build stays audio-only until a `Player` is wired. To turn
it on, provide a Media3 `Player` and drop in:

```kotlin
if (signedIn) {
    HorizontalDivider()
    val player: androidx.media3.common.Player? = /* your player */ null
    val party = com.beeboentertainment.auto.party.rememberParty(prefs, player)
    com.beeboentertainment.auto.party.PartyScreen(
        prefs = prefs,
        deviceName = prefs.userName.ifBlank { android.os.Build.MODEL },
        controller = party,
        videoContent = { /* PlayerView(player) */ },
    )
}
```

- **HOST**: bind `player` to the app's session player — e.g. a `MediaController`
  connected to `PlaybackService` — so the party drives the player the car already
  plays through.
- **VIEWER**: bind `player` to a local video `ExoPlayer` that renders into the
  `VideoWindow` slot.

`rememberParty(prefs, player)` returns null when there is no player or no
`hubToken`; `PartyScreen` still shows the slider and window in that state (join is
disabled), which is enough to pre-tune the audio delay. The controller is stopped
automatically when it leaves composition.

The nav graph is **not** touched.

---

## 7. Video window

`VideoWindow(prefs, content = { … })` is a self-contained frame; the actual video
surface is passed in as the `content` slot, so it never has to know how the
picture is produced and the existing player UI is untouched. Drag the top bar to
**move**, drag the bottom-right handle to **resize**, and "Disable screen" to
**hide** (audio keeps playing — the window never touches the player). Geometry
(position, size, hidden) persists to `Prefs.videoWindow` and is clamped inside its
parent's bounds, so it survives rotation and small screens. Place it as the top
layer of a Box that fills the area it may roam over (`PartyScreen` gives it a 16:9
stage).

---

## 8. Not device-tested — `TODO(device)` markers

This was written without a car/tablet to test on. Real-hardware tuning is marked
in code:

- `PartyController.DRIFT_THRESHOLD_MS` (250ms) and seek-vs-speed-nudge smoothness —
  `PartyController.applySync`.
- Surface/EGL lifecycle across move/resize (a `SurfaceView` can flicker or drop
  its surface on a mid-frame layout change) — `VideoWindow` class doc.
- Audio-focus interactions for a separate viewer `ExoPlayer` — see §5.
- Network latency is not compensated in the sync target (only elapsed-since-beat
  and the audio-delay offset are) — acceptable for a car LAN/hub, revisit if the
  hub RTT is high.
