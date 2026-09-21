# Stage 2 — WebRTC peer-to-peer client

> **Status (16 Sep 2026): reachable as a "Home PC link (test)" card, parked-only.** Signalling runs
> through the hub's `/signal` with the token in the Authorization header. It only connects when the PC
> runs `hub/agent` with `pc-webrtc.js`; the shipped desktop app doesn't, so most users see "Your PC isn't
> connected to the Beebo hub". Since 15 Sep the hub hands out STUN only, so mobile data behind carrier
> NAT usually fails ICE, and the app says so. Fixed: a missing native library (the APK ships arm64 only)
> crashed the app instead of failing; a rejected SDP or a silent PC hung on "Connecting" (now a 30s
> watchdog); the recv-only audio transceiver was removed so no sound bypasses the media session.

This adds a WebRTC client so the phone can reach the user's home PC **peer-to-peer**
when the PC sits behind a NAT/router with no port forwarding. The hub only relays
the SDP/ICE handshake; once ICE completes, video/audio/data flow directly between
phone and PC.

All new code lives under `com.beeboentertainment.auto.webrtc`. Everything is **additive** —
the existing direct-connection path (`connectVia == "direct"`) is untouched.

> The **PC side is a separate component** (the answerer), handled outside this app.
> This client is always the **offerer**: it creates the SDP offer and expects the
> PC to reply with an answer + its ICE candidates through the same relay.

---

## 1. Dependency added

No version catalog exists in this project (`gradle/` has only `wrapper/`), so the
coordinate was added directly to `app/build.gradle.kts`, in the `dependencies {}`
block next to OkHttp:

```kotlin
// Stage 2 peer-to-peer link to the home PC. Maintained Google WebRTC build
// (package org.webrtc), pulled from mavenCentral which settings.gradle.kts
// already declares. See WEBRTC-STAGE2.md.
implementation("io.github.webrtc-sdk:android:125.6422.07")
```

`mavenCentral()` is already declared in `settings.gradle.kts`, so no repository
change was needed. The artifact publishes the standard `org.webrtc.*` API (the
maintained webrtc-sdk build of Google's libwebrtc), which is what all the new code
imports. Nothing else in the build changed.

No `AndroidManifest.xml` change was needed: `INTERNET` is already declared, and a
**receive-only** peer connection captures no camera/mic, so no `CAMERA`/
`RECORD_AUDIO` permission is required.

---

## 2. New files

| File | Role |
|------|------|
| `webrtc/SignalingClient.kt` | OkHttp WebSocket to `/signal`. Transport only: knows the hub envelopes (`session-open`, `peer-offline`, `signal`, `session-closed`/`peer-gone`), hands the inner `payload` up verbatim. Reuses `Http.client(...)`. |
| `webrtc/WebRtcSession.kt` | Owns `PeerConnectionFactory` + `PeerConnection` built from the hub's ICE servers. Offerer flow (createOffer → setLocalDescription → send; onIceCandidate → send; apply remote answer/candidate). Recv-only video+audio transceivers, a `control` data channel, a `SurfaceViewRenderer` helper, and full `close()`/dispose. |
| `webrtc/WebRtcConnector.kt` | High-level entry. Fetches ICE, opens signalling, runs the handshake, surfaces `State` + the remote `VideoTrack` as `StateFlow`s. |

Two files were edited (minimally, additively):

- `hub/HubAuth.kt` — new `suspend fun startRemoteSession(context, sessionId?)`.
- `hub/HubClient.kt` — the `resolveAndApply` Stage 2 TODO comment now points at
  the real entry point. **Behavior is unchanged**: it still returns `false` for
  `connectVia == "signal"` because there is no direct address to store.

---

## 3. Public API of `WebRtcConnector`

```kotlin
class WebRtcConnector(context: Context, userJwt: String, trustAnyCert: Boolean = false) {

    sealed class State {
        object Idle; object Connecting; object Connected
        object PeerOffline                 // relay says PC offline (terminal)
        data class Failed(val reason: String) // terminal, message worth showing
    }

    val state: StateFlow<State>                 // observe for progress
    val remoteVideo: StateFlow<VideoTrack?>     // set when the PC's track arrives
    val sessionId: String

    suspend fun connect(sessionId: String = <random uuid>) // never throws; failures land in state
    fun sendControl(text: String): Boolean                 // over the data channel
    fun createRenderer(context: Context): SurfaceViewRenderer?
    fun releaseRenderer(renderer: SurfaceViewRenderer, track: VideoTrack?)
    fun close()                                            // idempotent, any thread
}
```

`connect()` suspends only for the `GET /api/v1/ice` call; the rest of the handshake
runs on the signalling/WebRTC threads and drives `state`.

---

## 4. How the app calls it when `connectVia == "signal"`

The entry point is `HubAuth.startRemoteSession(...)`:

```kotlin
// After resolveAndApply(token) returns false, check why:
val pc = HubClient(context).findPc(token)
if (pc.online && pc.connectVia == "signal") {
    // In a coroutine (e.g. lifecycleScope.launch { ... }):
    val connector = HubAuth.startRemoteSession(context) ?: return@launch // null => not signed in

    // Observe progress:
    connector.state.collect { s ->
        when (s) {
            WebRtcConnector.State.Connected -> { /* attach connector.remoteVideo to a renderer */ }
            WebRtcConnector.State.PeerOffline -> { /* show "PC offline" */ }
            is WebRtcConnector.State.Failed -> { /* show s.reason */ }
            else -> { /* Connecting / Idle spinner */ }
        }
    }

    // On screen dispose:
    connector.close()
}
```

Rendering the incoming track:

```kotlin
val renderer = connector.createRenderer(context)          // init'd on a live session
connector.remoteVideo.value?.addSink(renderer)            // do on the UI thread
// on teardown:
connector.releaseRenderer(renderer, connector.remoteVideo.value)
```

### Call sites to wire in (3)
1. **Branch decision** — wherever `resolveAndApply` is consumed today (its `false`
   return): when `false` and `pc.connectVia == "signal"`, take the WebRTC path
   instead of treating it as "not reachable".
2. **`HubAuth.startRemoteSession(context)`** — one call to build + start the
   connector; observe its `state`.
3. **A rendering surface** — a screen (Compose `AndroidView`/`DisposableEffect` or
   a plain `SurfaceViewRenderer` host) that attaches `remoteVideo` and calls
   `connector.close()` + `releaseRenderer(...)` on dispose.

---

## 5. Signalling wire shapes (chosen by this client, opaque to the hub)

Sent inside the hub's `{"type":"signal","payload":<blob>}` envelope:

```jsonc
{"kind":"offer","sdp":"<sdp text>"}                 // phone -> PC
{"kind":"answer","sdp":"<sdp text>"}                // PC -> phone (expected)
{"kind":"candidate","sdpMid":"0","sdpMLineIndex":0,"candidate":"candidate:..."}
```

ICE servers come from `GET /api/v1/ice` (Bearer userJWT) and are fed straight into
the `PeerConnection` config via `WebRtcSession.parseIceServers(...)` (handles both a
single `urls` string and an array, plus TURN `username`/`credential`).

---

## 6. On-device TODOs (cannot be validated here — no phone/camera/NAT)

These are marked with `TODO(device)` / `TODO(...)` in the source:

- **Renderer lifecycle / EGL** (`WebRtcSession.createRenderer`): `SurfaceViewRenderer.init`
  must run on the UI thread, and `release()` must run on the same thread that
  init'd it. Host it in a Compose `AndroidView` + `DisposableEffect` (or a View's
  attach/detach). The helper only does the `init` call.
- **Audio routing** (`WebRtcSession`, `pcObserver.onTrack`): inbound audio plays
  through the default sink; speakerphone vs. car A2DP routing, and whether to keep
  the audio transceiver at all, needs tuning against a real head unit.
- **DISCONNECTED handling** (`WebRtcConnector.sessionEvents.onIceState`): treated as
  a soft failure only before `Connected`; real reconnection/backoff after a mid-
  session drop is left for device testing.

## 7. Memory / lifecycle

`WebRtcSession.close()` disposes, in order, the data channel, the `PeerConnection`,
the `PeerConnectionFactory`, and the `EglBase`. `WebRtcConnector.close()` closes the
signalling socket and the session and clears the video track. Both are idempotent.
Always call `connector.close()` when the screen goes away.
