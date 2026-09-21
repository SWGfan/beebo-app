# Campsite synced music (v1)

The host phone plays a queue from the Beebo Music library and every guest phone (a plain browser, no app)
plays the same audio in sync. Built on the host's own Wi-Fi hub, so it works with no internet.

Status: implemented and unit/integration tested. **Not yet measured on real phones** - owner, the test script
at the bottom is how to do that. Numbers below are marked *simulated* (from the tests) or *expected*
(from the design and the physics of phone Wi-Fi) so nobody mistakes a target for a measurement.

## How it works

```
 Music player queue (host phone)
        |  "Play together"
        v
 CampsiteMusicHost ----- downloads current + next 2 songs from the Beebo computer into cacheDir/campsite-music
        |                (guests download them from the phone, not from the internet)
        v
 CampsiteMusicEngine  ----  queue, epochStart (host monotonic ms at which the current song's position 0 is heard),
        |                   roles, seq/rev counters. Pure Kotlin, injected clock, unit tested.
        v
 CampsiteMusicHub  ---- one WebSocket per guest (/api/music/ws), pushes a snapshot on every host command,
        |               answers clock-sync pings, collects each phone's status
        v
 guest browser: campsite-music.js  (inlined into /music)
     ClockSync  ->  offset between the host clock and performance.now()
     Player     ->  fetch + decodeAudioData ahead of time, source.start(audioContextTime, offset),
                    drift correction, left/right routing
```

### Why WebSocket, not long-poll or SSE

Clock sync needs many quick round trips on a **persistent** connection. `CampsiteServer` answers ordinary HTTP
with `Connection: close`, so an HTTP ping would put a fresh TCP handshake inside every measured round trip
(slower, jittery, asymmetric - exactly what an NTP-style estimate cannot tolerate). SSE is one-way, so each ping
would still need its own POST. A WebSocket is one open connection both ways, is supported by every mobile browser,
and the subset we need (handshake, text frames, ping/pong, close, masking, size limits) is about 150 lines
(`CampsiteWebSocket.kt`, no dependencies, unit tested against the RFC 6455 example key and hostile frames).
The 15 s server pings also keep the phone Wi-Fi radio from idling the connection out.

### Protocol (JSON text frames, version 1)

| direction | message | purpose |
|---|---|---|
| server -> guest | `{"t":"hello","v":1,"guest":"<12 hex>","serverNow":ms}` | first message |
| server -> guest | `{"t":"state", seq, rev, state, index, epochStart, pausedPos, role, queue:[{id,title,artist,album,ms}], serverNow, positionMs}` | on every change, and as the late-joiner snapshot (same shape - joining needs no special case) |
| guest -> server | `{"t":"ping","id":n,"c":perfNow}` | clock sync |
| server -> guest | `{"t":"pong","id":n,"c":..,"r":recvHostMs,"s":sendHostMs}` | `r` stamped when the frame is read, `s` stamped on the writer thread the instant before the bytes go out |
| guest -> server | `{"t":"status","state","unlocked","ready":trackId,"errMs","driftMs","rttMs"}` | host screen + the "everyone is ready" start gate |

`state` is one of `idle, preparing, playing, paused, ended`. `role` is `everyone | left | right | voice`.
Guests cannot send anything that changes what plays; unknown messages are counted and the guest is dropped after 10.

Track boundaries are **computed, not signalled**: track i+1 starts at `epochStart(i) + duration(i)`. Guests do the same
sum from the queue and pre-schedule the next track 6 s before it starts (gapless), so a track change needs no message to
arrive on time. Durations come from the library tags, so a song whose tag duration is wrong by more than ~50 ms will
be cut slightly or leave a small gap - every phone the same way, so they stay together.

### Clock sync

NTP style, per exchange: `rtt = (t3-t0) - (t2-t1)`, `offset = ((t1-t0) + (t2-t3)) / 2` (host minus guest).
A burst is 24 pings 60 ms apart on connect (10 pings 100 ms apart every 30 s afterwards, and one on tab wake).
Estimate: drop junk, keep the lowest-RTT half, take the median, discard outliers beyond max(3 sigma, 3 ms), median again.
Reported error = max(robust sigma, best RTT / 4, 0.5 ms); the hard bound is RTT / 2. Successive bursts are blended
(alpha 0.35) unless the offset jumps by more than 40 ms, which is believed at once.
The maths is in `CampsiteClockSync.kt` and mirrored in `assets/campsite-music.js`; both are checked against the same
vectors in `app/src/test/resources/campsite-clock-vectors.json`.

### Scheduling, catch-up and drift

* The guest maps a host time to the AudioContext time at which it will be **heard**, using `getOutputTimestamp()`
  (context time and `performance.now()` of the sample currently leaving the speaker, so output latency is included where
  the browser reports it). Fallback: `currentTime - outputLatency`.
* Start: `source.start(when, offset)` with `when` at the heard-time of `epochStart`. Late joiner or catch-up: `epochStart`
  is in the past, so it starts 120 ms from now at buffer offset `now - epochStart + 120 ms`.
* Drift: every 250 ms the phone compares where its source really is with where the host clock says it should be; the
  median of the last 5 readings drives a `playbackRate` nudge (max +-0.5%, about 9 cents, inaudible) that removes the
  error over about 2.5 s. Above 12 ms it engages, below 5 ms it releases, above 250 ms it restarts the source at the right place.
* Host pause / seek / next / previous / new queue: a new snapshot; sources are stopped or restarted at the new position.
  Commands take effect 500-700 ms in the future so every phone has the message first.
* "Everyone ready": after `load`, playback starts when every phone that has tapped to unlock reports the first track decoded,
  or after 20 s, then 1.5 s later. Phones that have not tapped are not waited for; they join in progress when they do.
* Memory: a decoded song is raw floats (~11 MB per minute of stereo). Songs over 12 minutes are skipped; only the current
  song is decoded, the next one's compressed bytes are fetched early and decoded 30 s before it is needed.

### Roles

`everyone` (default) plays the whole mix. `left` / `right` play only that channel on both of the phone's speakers, so
two phones one either side of the camp form a stereo pair; the host screen has All / Left / Right buttons per guest.
`voice` is carried by the protocol as groundwork for Campfire voice-casting; for now it plays the same as `everyone`
(no voice content is distributed yet). Routing is a persistent 2x2 gain matrix, so a role change is click-free and does not
restart the audio.

### Security

Guests are on the host's local Wi-Fi only, but: the WebSocket upgrade and the track download both need the join
cookie (`beebo_play`, HttpOnly, SameSite=Strict) that `/join` issues; a cross-site `Origin` or `Sec-Fetch-Site` is refused;
guests can only download tracks that are in the current queue (never the library); ids are validated against
`^[A-Za-z0-9_-]{1,64}$` and never touch a file path unchecked; client frames must be masked and are capped at 4 KB
(refused before the payload is read); a token bucket (100 burst, 50/s) closes a flooding guest; the outbox per guest is
bounded so a stalled phone is dropped rather than stalling everyone; max 32 sockets, one per guest (a reconnect replaces
the old one); every string from music tags or guests is written with `textContent`, never as markup; the served script is
the host's own asset, inlined, with no third-party code. Songs are cached on the host only while Campsite runs.

## Sync accuracy

What is limited by what:

| source of error | size | handled by |
|---|---|---|
| clock offset estimate (asymmetric Wi-Fi legs) | expected 1-5 ms on a quiet hotspot, bursts to 20-50 ms; median of the best half of 24 pings usually lands within 2-8 ms | ClockSync, re-run every 30 s |
| guest audio clock vs host clock (crystal drift) | typically 10-100 ppm = 2-24 ms over a 4 min song, up to 60 ms over 10 min | playbackRate nudges, restart if >250 ms |
| `AudioContext` scheduling | sample-accurate once armed (< 1 ms) | Web Audio |
| output latency | 10-40 ms on built-in speakers (mostly compensated when the browser reports it); **100-250 ms on Bluetooth speakers, not reported** | per-phone trim buttons (+-10 ms steps) |
| browser reporting quality (`getOutputTimestamp` jitter) | a few ms; Safari support is weaker | median filter over 5 readings, deadband |

Simulated (node tests, `campsite-music.test.js`, fake AudioContext whose hardware clock runs fast or slow and whose
speaker is 30 ms behind the render clock): the closed loop holds the true position error to about **13 ms worst case at
+-2000 ppm** (a far worse crystal than any real phone) and never needs a restart. Clock estimate on synthetic Wi-Fi with
25% one-legged 25-60 ms spikes: within 0.1 ms of the true offset; with a constant 2 ms asymmetry (undetectable by any RTT method) 1.1 ms of bias.

Measured, desktop Chromium against a real `CampsiteServer` on loopback (the `CampsiteMusicBrowserFixtureTest` fixture,
two guest tabs on different origins, so two cookies, two sockets, two AudioContexts, two clock estimates): both tabs
connected, synced clocks (RTT 0.4-0.5 ms, error 0.5 ms), decoded the WAV tracks, started on the "everyone ready" gate, and the
wall-clock instant at which each tab reported hearing position 5.000 s of the song differed by **0.2 ms**. Seek, track rollover
(gapless, no restart), pause and a per-guest Left role were also driven from the host side and observed in the tabs.
That validates the whole pipeline (handshake, clock sync, fetch, decode, scheduling, roles); it says nothing about Wi-Fi jitter
or phone audio hardware because both tabs share one machine and one clock.

Expected on real phones: **most guests within 10-20 ms of the host, occasional 30-60 ms** for a phone with a noisy radio
or a Bluetooth speaker until it is trimmed. That is "together" for group music (about 20-30 ms is where two speakers stop
sounding like one) and not good enough for hard-panned stereo effects across two phones; the left/right split is a fun
party feature, not a calibrated stereo system. **None of this has been measured on hardware yet.**

The on-page indicator: green "In sync" when clock error + current drift is at most 30 ms, amber up to 80 ms, red above.
It is an *estimate*: it cannot see output latency, which is why the trim buttons exist.

## Known limits

* **The host phone is the conductor, not a speaker.** Play together pauses this phone's own Music player. Playing on the
  host too, in sync, needs a native scheduled start (ExoPlayer seek + play at a deadline); deferred.
* The guest tab must stay open with the screen on. Web Wake Lock needs HTTPS (not available on `http://192.168.x.x`), so the
  page plays a silent looping `<audio>` to hold a media session and sets lock-screen metadata. Whether that keeps the
  phone alive with the screen off varies by phone/browser - see the test script. Leaving the page stops the music on that
  phone; returning catches up by itself.
* iOS Safari suspends the AudioContext after a call or lock: the page shows "Tap to enable audio" again.
* Music only comes from the Beebo computer library (the host needs a connection to it once, to download the songs).
  Offline-only libraries on the phone are not read.
* ~8 guests on one hotspot is the design point. Each guest downloads each song (about 6-8 MB at the 256 kbps we ask for);
  8 guests x 8 MB is roughly 10-20 s of hotspot time, which is why songs are prefetched and the start waits for readiness.
* Movies, phone-surround and Campfire voice-casting are later steps (roles are only the protocol groundwork).

## Files

Kotlin (`apps/core/app/src/main/java/com/beeboentertainment/movie/campsite/`):
`CampsiteWebSocket.kt`, `CampsiteClockSync.kt`, `CampsiteMusic.kt` (engine), `CampsiteMusicHub.kt`,
`CampsiteMusicLibrary.kt` (cache + mime), `CampsiteMusicHost.kt` (host controller, downloads), `CampsiteMusicCard.kt` (host UI),
`CampsiteMusicPage.kt` (guest page). Small edits: `CampsiteServer.kt` (routes `/api/music/ws`, `/music`, `/music/track`,
`/join?next=music`), `CampsiteWebPages.kt` (Music tab, `page()` made internal), `CampsiteHost.kt`, `CampsiteScreen.kt`.
Guest script: `app/src/main/assets/campsite-music.js`.
Tests: `CampsiteWebSocketTest`, `CampsiteClockSyncTest`, `CampsiteMusicEngineTest` (+ cache), `CampsiteMusicHubTest`
(real server, real socket), and node: `node --test apps/core/tools/campsite-music/campsite-music.test.js`.
`CampsiteMusicBrowserFixtureTest` is an opt-in fixture (`BEEBO_MUSIC_FIXTURE=<folder>`) that serves generated tracks to a
real browser for manual checks. Regenerate the shared clock vectors with `node apps/core/tools/campsite-music/gen-clock-vectors.js`.

## Manual multi-device test script (for the owner)

You need: the host phone with a Beebo build containing this, 2-3 guest phones (ideally one Android + one iPhone), a Music
library on the Beebo computer with a few songs of 2-6 minutes, and a way to hear two phones at once (a table is fine). A
second person makes it easier. A 60 fps or 240 fps phone camera pointed at two phones' screens is the way to measure.

1. **Setup.** On the host: Music, queue an album, start one song. Campsite, Invite guests, pick the Wi-Fi mode, show the QR.
   Guests scan it, join, open **Music** from the bottom tab.
2. **Connect check.** Each guest page should show "Syncing clocks..." then a sync line within ~3 s. On the host card,
   each guest appears under "Guest phones". Note the +-ms figure per phone.
3. **Unlock.** On each guest tap **Tap to enable audio**. Host card shows the phone as ready.
4. **Start.** On the host tap **Play together**. Expect: this phone's own player pauses, guests show "Downloading the
   track...", then all phones start within about 2 s of each other. Listen from a spot equidistant from two phones: it should
   sound like one source, not an echo. Put two phones side by side and start a song with a sharp beat (the fixture's click track
   works too): flam or echo = out of sync.
5. **Measure.** Record two phones side by side, 240 fps if possible, playing a clicky song, with the speakers close to a
   phone microphone or just listen with headphones split (one ear per phone, phones next to each other). Difference per click
   in ms is the sync error. Repeat at 10 s, 1 min, 3 min (drift) and after a track change. Write the numbers into this file.
6. **Late joiner.** Join a fourth phone mid-song: after the tap it should catch up to the same beat within ~1-2 s.
7. **Controls.** From the host card: Pause (all stop together), Play (all resume together), Next, Previous, Stop. Seek is
   in the engine and protocol but the host card does not expose a slider in v1.
8. **Stress.** Walk a guest to the edge of Wi-Fi range and back: it should say "Reconnecting...", then rejoin and re-sync on its
   own. Lock a guest's screen for 30 s and unlock: note whether it kept playing, and whether it caught up.
9. **Roles.** Put two guests one either side of you and set one to **Left**, one to **Right** on the host card. Each phone
   should play only its side of a song with clearly different left/right content.
10. **Trim.** With a Bluetooth speaker on one guest, use the -10 / +10 ms buttons on that guest until it lines up; note the value needed.
11. **Browsers.** Repeat the basics on Chrome Android, Safari iOS and Samsung Internet. Note: does "In sync" go green,
    does the AudioContext survive a notification sound, does the silent-audio trick show a lock-screen "Beebo" player.
12. **Idle-stop.** Leave music playing 20 minutes with only sockets (no page loads): Campsite must not stop itself (guest
    sockets refresh the "guest is here" clock).

Record for each browser/phone: worst and typical offset, whether drift needed correcting, any glitches at track changes,
and battery cost on a guest over 30 minutes.

## What needs real phones to verify

* Real sync error distribution on a `BeeboWifi` hotspot (the numbers above are simulated/expected).
* `getOutputTimestamp` / `outputLatency` behaviour per browser (Safari especially), and Bluetooth latency.
* Background/lock-screen behaviour of the silent-audio keepalive on Android Chrome and iOS Safari.
* Decode memory on low-end phones (a 12 min song is ~130 MB decoded).
* Hotspot throughput with 6-8 guests downloading at once.
* `decodeAudioData` support for the formats the Beebo computer sends (MP3/AAC/WAV are requested explicitly).
