# Android app: screens for the newer server features

The desktop server gained Live TV, Audiobooks, Podcasts, Internet radio, two-factor sign-in with an Account
security page, and Watch together. Each already had a bearer-token JSON API and a website page; the phone/TV app
had no screens for them. This change adds them to `apps/core` (package `com.beeboentertainment.movie`), for the
`web`, `play` and `amazon` flavors, with no Google Play services code (the Amazon policy guard stays clean).

Status of this document: written from the server code and docs as read on 2026-09-21. Podcasts/Radio and Watch
together were on unmerged server branches at that time (`podcastApi.js`, `radioApi.js`, `watchTogetherHttp.js`,
`docs/PODCASTS-AND-RADIO.md`, `docs/WATCH-TOGETHER.md`); the routes below are their contract as read then.

## Where the screens are

Everything opens from **More** (no new tab, so the five-tab layout, the TV rail and the old-route migration are
untouched). An entry only appears when the connected computer supports it.

| Entry in More | Route | Shown when |
| --- | --- | --- |
| Account security (under Account) | `account-security` | `GET /api/account/security/status` answers 200 (not a shared-library guest) |
| Live TV (under Watch) | `livetv`, `livetv/watch/{key}` | `GET /api/livetv/status` says `enabled` and `channelCount > 0`, and the profile is allowed |
| Join a watch together room (under Watch) | `join-watch-together` | `POST /api/watch-together/ping` answers with `t1` and `t2` |
| Audiobooks (under Listen) | `audiobooks`, `audiobooks/book/{id}`, `audiobooks/series/{id}`, `audiobooks/listen` | `GET /api/audiobooks/status` says `configured` |
| Podcasts (under Listen) | `podcasts`, `podcasts/show/{id}`, `podcasts/listen` | `GET /api/podcasts/status` answers 200 |
| Radio (under Listen) | `radio`, `radio/listen` | `GET /api/radio/status` answers 200 |
| Movie Night (under Watch) | `movienight` | `GET /api/movie-night/status` says `available` (docs/MOVIE-NIGHT.md; a web view that can only visit the computer, so it also works on Fire TV with no Play services) |

Also: the two-step code prompt on the sign-in screen (shown after a right password when the account has
two-factor), and a **Room** button in the video player (hidden unless the computer supports Watch together).

Feature detection (`server/ServerFeatures.kt`) asks the server rather than comparing versions. A 404, a page that is
not Beebo JSON, or a timeout hides the entry; the answers are cached for five minutes and dropped when the person
or address changes. A live TV answer of 403 `restricted_profile` / `not_available_to_guests` hides Live TV, and a
direct link to it shows the reason instead of a black screen.

## Routes used (all bearer token, JSON)

**Sign-in and account security**
- `POST /api/login` - a `401` with `error: two_factor_required` and `challenge` now starts the second step.
- `POST /api/login/2fa` `{ challenge, code }` - 6-digit app code or a recovery code (`XXXXX-XXXXX`). Wrong code keeps the
  challenge; `challenge_expired` and a lock send the person back to the password; `two_factor_setup_required` explains the
  owner's policy.
- Away from home the same step runs over the tunnel: `POST /api/remote-session` answers `two_factor_required` and the code goes to
  `/api/login/2fa` through the tunnel that is already open (`RemoteAccess.completeSecondStep`).
- `GET /api/account/security/status`, `POST .../sessions/revoke {id}`, `POST .../sessions/revoke-all {includeCurrent}`.
  "Sign out everywhere else" keeps this phone: the server ends every session and hands back a fresh token, which is stored
  (otherwise the phone would be signed out too). Setting up two-factor, recovery codes and changing the password stay on the
  website (QR code and a page of codes to save).

**Live TV** - `GET /api/livetv/status`, `GET /api/livetv/channels`, `GET /api/livetv/guide?hours=3`, `POST /api/livetv/favourite {channel,on}`,
`POST /api/livetv/watch {channel}`, `POST /api/livetv/stop {ticket}`. Playback is the live HLS playlist at the address `watch`
returns (`/livetv/hls/<ticket>/index.m3u8`, the signed ticket is the credential, no bearer header needed), played by Media3 over the app's
own OkHttp client (so over the tunnel away from home). `503 tuners_busy`, `403 restricted_profile`, `409 off`, `502 no_signal` each get a
plain message. Changing channel stops the old ticket first so a one-tuner setup can switch.

**Audiobooks** - `GET /api/audiobooks/status|books|series|series/<id>|continue|search|book/<id>`, `PUT /api/audiobooks/book/<id>/progress`,
`POST /api/audiobooks/progress/batch`, `POST .../book/<id>/finished`, `POST|DELETE .../bookmarks`, `PUT /api/audiobooks/prefs`. Audio:
`GET /api/audiobooks/book/<id>/stream/<part>` with the bearer header (`?codecs=` added for formats the phone cannot decode).

**Podcasts** - `GET /api/podcasts/status|subscriptions|latest|continue|queue|show/<id>|episode/<key>|episode/<key>/chapters|search|prefs`,
`POST /api/podcasts/subscriptions {url}`, `DELETE .../subscriptions/<id>`, `POST .../refresh`, `POST|DELETE .../queue`, `POST .../episode/<key>/progress|played`,
`POST|DELETE .../episode/<key>/download`, `POST .../prefs`. Audio: `GET /api/podcasts/episode/<key>/stream`. The app says "Follow", not the store-banned
verb.

**Radio** - `GET /api/radio/status|browse|favorites|custom|recent|session/<id>`, `POST /api/radio/play {stationId}`, `POST|DELETE .../favorites`,
`POST|DELETE .../custom`, `DELETE .../session/<id>`. Audio: the computer's relay `GET /api/radio/session/<id>/stream`. The station's own address
is never modelled, shown or played.

**Watch together** - `POST /api/watch-together/ping|create|join|leave|command|ready|chat|react|settings|transfer|kick|close`,
`GET .../room?code=`, `GET .../poll?code=&since=`, and the Server-Sent Events stream `GET .../events?code=` (bearer header, `Last-Event-ID` on reconnect,
falls back to polling once a second if streams keep breaking, retries the stream every half minute).

## How it is built

- `server/ServerJson.kt` - one small bearer-token JSON client (over `ApiClient.okHttp`, so the tunnel and the cleartext policy apply). A 401 with no reason is a
  dead session (`UnauthorizedException`, back to sign-in); a 401 that names a reason (`wrong_password`, `invalid_code`) is an answer.
- `server/SafeText.kt` - everything the server sends that is shown (channel names, book titles, chat, station names, show notes) is stripped of control,
  bidirectional and zero-width characters and length-capped; show notes are turned into plain text (never rendered as markup); third-party artwork loads only
  over https; a server-relative address is only accepted when it is exactly the expected kind of path on this server (so the bearer token can never be
  sent to another host). Nothing logs a URL, a ticket, a room code or a token. The room code is kept in memory only and handed to the player screen in memory,
  not in an Intent.
- **One audio service.** Audiobooks, podcasts and radio play through the existing `MusicPlaybackService` (Media3 `MediaSessionService`), so background
  playback, the notification, the lock screen, headset buttons and the mini player work for all of them. Items carry an `AudioKind`; for spoken kinds
  the service asks for speech audio focus, exposes back/forward skip buttons (custom session commands, lengths from the server's preferences) and the
  bearer token is added only to this server's own audio addresses (`AudioStreamRules`). Music's behaviour, gain and queue are unchanged; starting a song
  resets speed to 1x. Playback speed is 0.5x to 3x in 0.05 steps with the pitch kept (Media3's default); the sleep timer (minutes with a 10 s fade,
  end of chapter or episode) runs in the app and pauses the service.
- **Resume sync (audiobooks).** The position is sent every 15 s while playing and immediately on pause/stop. The most recent listen wins (same rule as the server):
  on opening a book the server's position and any position kept on this phone are compared by `updatedAt`. A position that could not be sent is kept per
  signed-in person and sent as a batch (`POST /progress/batch`) when the computer is reachable again. Podcast progress uses the same cadence.
- **Watch together engine** (`watchtogether/WtSync.kt`, `WtEngine.kt`) is a port of the server's own sync maths (clock offset by NTP-style pings, drift
  nudges of at most 5% under 1.5 s, seek above, synchronised starts, buffering holds), written against a small player interface so it is unit tested with a fake player.

## What was verified

**Unit tests only** (JUnit on the JVM, mocked JSON, a fake OkHttp interceptor standing in for the server; no device, no emulator, no real server):
`server/*` (safe text, error mapping, feature detection, the JSON client), `security/*` (second-step rules, tunnel step, device list, routes and bodies),
`audiobooks/*` (timeline across parts, speed, chapters, sleep timer, newest-wins resume, pending positions, client routes), `podcasts/*`, `radio/*`, `livetv/*` (ordering,
favourites, guide layout, messages, time-shift, keys), `watchtogether/*` (sync maths, invite parsing, event stream parsing, engine with a fake player, client routes),
`audio/*` (routes, stream-address rules). The existing suites, the payments-wording guard and the Play/Amazon policy guards still run and pass with the new code.

Build note: running the web, play and amazon test tasks in one Gradle call compiles two flavors in the same Kotlin daemon; with the repo's `-Xmx3g` daemon
setting that ran out of memory once ("GC overhead limit exceeded"). It passed with `-Pkotlin.daemon.jvmargs=-Xmx5g` (all three flavors' unit tests, the Play and Amazon
policy guards, and `assembleWebDebug`). Run with `--max-workers=2`.

## What needs a real phone or TV

Nothing below has been run on a device.

1. Two-factor sign-in at home and away from home (tunnel) on an account with two-factor on; recovery code; wrong-code lock; "Sign out everywhere else" keeping the phone signed in (the fresh token).
2. Live TV with a real HDHomeRun: start, pause, rewind 30 s, Go live, channel up/down, the busy-tuner message with all tuners in use elsewhere, leaving the screen frees the tuner, playing over the tunnel, D-pad and remote channel keys on Android TV / Fire TV, a profile with parental controls.
3. Audiobook, podcast and radio playback with the screen off, notification and lock-screen controls (skip buttons appearing only for spoken content), Bluetooth/headset keys, audio focus taking turns with music and with a film, speed 0.5x/3x on real audio, sleep-timer fade, an m4b with chapters, a multi-file book crossing parts, position following between two devices, offline then reconnect batch, killing the app mid-listen.
4. Watch together on two devices: join by pasted link and by code, synchronised start, drift nudging on a real network, someone buffering pausing the room, host controls, chat/reactions, SSE through the tunnel and through a relay that buffers streams (polling fallback), the host changing title.
5. TV layouts of all new screens (focus order, the text boxes that open the keyboard on select, the guide grid with a remote).
6. Release build with minification (the models rely on the existing serialization keep rules for `com.beeboentertainment.movie.**`).

## Not done / deferred

- No Android Auto / car screens for these (Beebo Auto is a separate app), no Cast of live TV or audiobooks.
- Live TV: no recordings (DVR) screens, no owner set-up (tuner, guide source) - those stay on the computer; no picture-in-picture for live TV; the guide is a simple three-hour grid.
- Audiobooks: no reading-order shelf, no author pages, no bookmark notes editing (bookmarks are added with an empty note), no "hide finished".
- Podcasts: no OPML import/export, no auto-download settings, no skip-silence toggle (the server's `nosilence` variant), no transcripts, no queue reordering.
- Radio: the notification shows the station name only (the track name from the stream is shown in the app, polled every 8 s); no radio recordings; no browse by country/language lists (search and quick tags only).
- Watch together: no "next episode" button in the panel (a host's title change is followed, but the phone cannot send one), no floating reaction animations, no deep link that opens the app from an invite tapped elsewhere (paste the link or code), no room list.
- The server's Jellyfin-style and web pages are unchanged; nothing was added to the desktop server.

## Home theatre and Movie Night (2026-09-21, unverified on devices)

- **Device profile and plan.** `player/DeviceProfileProbe.kt` reads `MediaCodecList` (hardware decoders only), `Display.HdrCapabilities`, Media3's `AudioCapabilities` (what the HDMI receiver accepts, the same object the player's sink follows) and the
  "HDMI passthrough" setting; `core/HomeTheater.kt` turns that into the declaration (`DeviceProfileBuilder`, unit tested in `HomeTheaterTest`). **TrueHD / DTS / DTS-HD passthrough is OFF unless the output reports the encoding** (and the setting is not Off),
  DTS:X is never claimed, Atmos only when the output reports E-AC-3 JOC. When `GET /api/playback/info` has the `homeTheater` block, `PlaybackChoicesController` asks `POST /api/playback/negotiate` (declaration in the body) for the original: direct play changes nothing
  (the file keeps playing), a **direct stream** swaps in the repackaged HLS (label "Original · direct stream"), a **transcode** uses the existing conversion path. It is skipped while casting (the declaration describes this device), for an explicit
  conversion, and with a picture subtitle that has to be burnt in. "Preparing" is asked again up to 4 times while the original plays; any failure leaves the original playing exactly as before. If a direct stream errors the player goes back to the file once.
- **Movie Night.** More > Movie Night (shown when `GET /api/movie-night/status` says `available`): starts a room (`POST /api/movie-night/tv/create`) and opens the computer's own page in a `WebView` restricted to that computer (`MovieNight.allowsNavigation`, tested); no Play services.
  Back leaves the screen. UNVERIFIED: the page's remote handling and focus inside the TV web view.
