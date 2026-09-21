# Beebo Entertainment for Roku

A Roku channel (BrightScript + SceneGraph) that plays the movies and shows on **your own Beebo
server** (the Beebo desktop app on your PC). It bundles no content; it is a client, like the phone
app.

> **Status: written and checked off-device.** Nothing here has been run on a real Roku. What *was*
> checked is listed under [What was verified](#what-was-verified) and [What is not verified](#what-is-not-verified).
> Read [Top risks](#top-risks-test-these-first) before you sideload.

## What it does (v1)

| Area | Behaviour |
| --- | --- |
| First run | Scans the Roku's own /24 for a Beebo server (`GET /api/ping`, port 47811), or you type an address, a Beebo name (`<name>.home.beebo.tv:47811`), or use a phone code (see *Sign-in*). |
| Sign in | A **phone code** (approve on the phone, nothing typed on the remote) that ends at `POST /api/viewer-session` on the home server (a 30-day API token), or username + password against `POST /api/login` (on-screen keyboard). See *Sign-in*. |
| Home | Continue Watching + Recently Added rows; Movies and TV Shows grids (lazily paged); Playlists; Search (keyboard + voice where the remote has a mic); Settings. |
| Detail | Backdrop/poster/synopsis, year/runtime/rating/quality, Play / Resume / Start over, audio and subtitle choice (movies), seasons and episodes (shows) with watched marks. |
| Playback | Roku `Video` node. On a server with `POST /api/playback/negotiate` the Roku sends its **device profile** and plays what the server picks (the file as it is, a repackaged HLS stream, or the H.264 + AAC conversion); on an older server it plays the H.264 + AAC HLS transcode as before. Resume, progress every 15 s and on pause/stop/finish, playlist queues, "try a lower quality" on error, and one automatic fall back to the conversion if a direct play fails. OK / Play / Pause / FF / RW / replay are the Video node's own. |
| Movie Night | A **Movie Night** tab that checks `GET /api/movie-night/status` and shows the address (`<server>/tv`) to open on a device that has a browser. A Roku has no web view, so it cannot draw the games itself (see *Movie Night*). |
| Remote | Full D-pad focus (tabs <-> content <-> grids/lists), Back walks up then exits, focus ring on everything, FHD layout inside the 5% title-safe margins. |

## Layout

```
apps/roku/
  manifest                       channel manifest (ui_resolutions=fhd, PLACEHOLDER art)
  bsconfig.json                  BrighterScript project (lint + package)
  build.mjs                      lint (fails on any diagnostic) + zip -> out/beebo-roku.zip
  package.json                   devDependencies only: brighterscript, @rokucommunity/brs
  source/main.brs                entry; owns the screen, forwards launch args
  components/
    BeeboScene.*                 root: global state, view stack, sign-in expiry
    views/                       BeeboView (base) + Setup, Pair, SignIn, Home, Detail, Search,
                                 Playlists, MovieNight, Settings, Player
    widgets/                     ButtonRow (buttons / tab bar), StatusPanel, PickerDialog, LibraryGrid
    items/PosterItem.*           grid/row cell
    tasks/HttpTask.*             one HTTP request on a background thread
    tasks/DiscoveryTask.*        LAN scan for a Beebo server
    lib/                         shared BrightScript (pulled in with <script> tags)
      Theme.brs                  THE ONE PLACE for colors, fonts, sizes  <-- restyle here
      PairingContract.brs        THE ONE PLACE that knows the tvpair wire format
      DeviceProfile.brs          THE ONE PLACE that builds the device profile + the negotiate body/answer  <-- pure, unit-tested
      MovieNight.brs             Movie Night address + status text (pure, unit-tested)
      DeviceProbe.brs            Roku-only: asks roDeviceInfo what this Roku can decode / show (not unit-tested)
      Urls / Format / Paging / Models / Playback / Discovery / PairingMachine / Log   (pure, unit-tested)
      Api / Registry / Nodes     Roku-only glue (not unit-tested)
  images/PLACEHOLDER_*.png       generated placeholder art (npm run placeholders)
  test/                          brs-interpreter tests of the pure logic
  tools/mock-server.mjs          fake Beebo server for UI work without a library
  tools/make-placeholders.mjs    writes the placeholder PNGs
```

## Build, test, sideload

```
cd apps/roku
npm install
npm run lint     # BrighterScript: every .brs/.xml, 0 diagnostics required
npm test         # 370+ checks of the pure logic under the brs interpreter
npm run build    # lint + out/beebo-roku.zip   (also built by .github/workflows/roku-build.yml)
```

**Sideload (Roku developer mode):**

1. On the Roku remote press: **Home x3, Up x2, Right, Left, Right, Left, Right**. Enable developer
   mode, accept the terms, set a web-server password, let it reboot.
2. Find the Roku's IP address (Settings > Network > About).
3. On your PC open `http://<roku-ip>` (user `rokudev`, the password you set), **Upload**
   `out/beebo-roku.zip`, then **Install**. The channel starts.
4. Debug output: `telnet <roku-ip> 8085` (BrightScript console). The channel never prints tokens,
   device codes, HLS tickets or media tokens (`lib/Log.brs`, unit-tested).

**Try it without a Beebo library:** `node tools/mock-server.mjs 47999` on your PC (47811 is the real
Beebo port; use another one if Beebo runs on the same PC), then in the channel choose *Type a server
address* and enter `<pc-ip>:47999` (user `demo`, password `demo`).

## How it talks to the server

It uses the same `/api/*` routes as the phone app and the web viewer, except that library lists
use the **paged public API** where the server has it.

| Purpose | Route | Notes |
| --- | --- | --- |
| Find server | `GET /api/ping` | no login; answer must be `{app:"beeboentertainment"}` |
| Sign in | `POST /api/login {username,password}` | returns a long-lived bearer token (kept in the registry) |
| Movies / TV shows | `GET /api/v1/library/movies` / `tvshows?limit=56&offset=&sort=&q=` | **server-side paging**. On 404/403/405 (older server) falls back to `GET /api/movies` / `/api/tvshows`, one unpaged list paged on the Roku |
| Continue Watching | `GET /api/continue` | rows carry `currentTime`/`duration` for exact resume |
| Recently Added | `GET /api/recently-added` | 24 rows |
| Episodes | `GET /api/tvshows/<key>/episodes` | seasons, watched %, names |
| Search | the two list routes with `q=` | debounced 0.6 s |
| Playlists | `GET /api/playlists`, `/api/playlists/<id>` | music tracks are skipped |
| Playback | `GET /api/playback/info`, `POST /api/playback/negotiate {kind,id,client:"roku",deviceProfile,quality,audio?}` (only when `info.homeTheater` exists), else `POST /api/playback/start {kind,id,quality,audio?}` -> `/hls/<ticket>/index.m3u8`; `POST /api/playback/stop` | See *Home theatre* below. The conversion is H.264+AAC MPEG-TS HLS, VOD. Quality: "auto" = the server plays the file as it is when it can (`quality:"original"`), or on an older server the best non-upscale of 1080p/720p/480p |
| Movie Night | `GET /api/movie-night/status` | availability only (see *Movie Night*) |
| Progress | `POST /api/watch-session {kind,id}` -> `sessionId`; `POST /api/progress {sessionId,currentTime,duration}` | camelCase keys are required; the JSON is built case-sensitively |
| Images | `/media/poster/<id>.jpg`, `/media/poster-tv/<id>.jpg` | public; TMDB backdrops are https and fetched directly |

On a **server without the negotiate route** the Roku still always asks for the H.264/AAC HLS conversion (the scoping doc's codec risk: HEVC, MKV, DTS on cheap Rokus). See *Home theatre*.

### Finding the server; home vs away

* **At home:** the Roku scans its /24. Beebo serves **plain http on port 47811 to private-LAN clients**
  (no certificate can name a LAN IP), so the channel talks `http://192.168.x.x:47811`. Plain http is
  accepted **only** for private/LAN hosts (same rule as the Android app's `CleartextPolicy`); anything
  else typed as `http://` is upgraded to `https://`, and the HTTP task refuses non-LAN http outright.
* **Away:** a Roku has no WebRTC, so it cannot use the phone app's tunnel and **`<name>.beebo.tv` is
  no use** (that host is Beebo's signalling page, not an API). The only away-from-home route that
  speaks plain HTTPS is the **direct home address `https://<name>.home.beebo.tv:47811`** (see
  `docs/HOME-ADDRESS.md`): it needs the house's router to forward port 47811 and the desktop's
  Let's Encrypt certificate. "Use my Beebo name" builds that address and checks it with `/api/ping`.
  A house behind carrier-grade NAT cannot be reached this way. Away, the home server's plan gate
  (`remote_requires_plan`, 402) is shown as a friendly message.

### Sign-in and the tvpair contract

`components/lib/PairingContract.brs` is coded against the **merged** `worker/tvPair.js` (`POST /tvpair/start`, `/tvpair/poll`, RFC 8628 style: code shown large with `beebo.tv/tv`, polling at the
server's `interval`, `slow_down` = 429 handled, expiry, denial reasons, feature-off = 404) and the desktop's **`POST /api/viewer-session`** (`desktop/apps/desktop/docs/VIEWER-EXCHANGE.md`), exactly as `apps/smarttv` and
`apps/apple` use it. The state machine (`PairingMachine.brs`) is pure and unit-tested.

What "approved" hands the Roku is a 12-hour **viewer** token plus the house `name`. The Roku then:

1. picks the server: the address it already has, else `https://<name>.home.beebo.tv:47811` built from the house name and checked with `/api/ping`;
2. sends **one** `POST <server>/api/viewer-session` with `Authorization: Bearer <viewer token>` and `{ "deviceName": "<the Roku's name>" }` (`PairView.startExchange`). The token goes only in that header, only over https or to a private
   LAN address (`pairSafeExchangeUrl`), is never stored, logged or kept in the state machine, and is cleared as soon as the server answers;
3. on `200 { token, user, ... }` stores the **30-day API token** exactly like an `/api/login` token (the `paired` action in `BeeboScene`) and opens Home;
4. on anything else falls back to the typed username + password with a plain sentence saying why (`pairExchangeText`): 404 older server, 401 "pair again" (never retried: ten wrong tokens lock the address for 15 minutes),
   403 (two-factor, private profile, administrator, no away-from-home access, owner switched it off, household / guest pass), 402 relay plan, 429, or no answer (asked again **once** if the reply never arrived).

`Api.brs` gained a one-off `bearer` option for this call; a 401 for it never counts as "the saved sign-in was rejected". Passwords are never stored: they are sent to `/api/login` only and the field is cleared.

## Home theatre: the device profile and the plan

`components/lib/DeviceProfile.brs` (pure) builds the capability declaration from what `DeviceProbe.brs` reads from `roDeviceInfo` at start-up (`CanDecodeVideo` / `CanDecodeAudio`, `GetVideoMode`, `GetDisplayType`,
`GetDisplayProperties`), and the player sends it in the body of `POST /api/playback/negotiate`. Honest by construction (unit tests pin every rule): a codec is listed only when `roDeviceInfo` said yes; HDR only when the display
said so, otherwise `hdr: []` (the server tone-maps); **Dolby Vision, HDR10+ and Atmos are never claimed; TrueHD, DTS-HD and DTS:X are never listed; DTS core is listed (pass-through only) only when `CanDecodeAudio` reports it**;
`maxHeight` is 2160 only for a 4K-capable output. Containers are the ones Roku documents (mp4, mov, mkv, ts); streaming is HLS (ts and fmp4).

The player follows the plan: **DirectPlay** = the Video node opens `/file?...` with `streamFormat` mp4 / mkv / ts; **DirectStream** and **Transcode** = HLS. A "preparing" answer is asked again up to 8 times. A chosen audio track always uses
the conversion. If the Video node errors on a direct play or direct stream the Roku goes back **once** to the plain conversion from the same position. A server without the `homeTheater` block in `/api/playback/info` is played exactly as before.

## Movie Night

The desktop server draws Movie Night as a web page and phones join by scanning its QR code (`docs/MOVIE-NIGHT.md`). A Roku has no web view and no QR generator in SceneGraph, so the **Movie Night** tab only checks
`GET /api/movie-night/status` and shows the address to open (`<server>/tv`) on a laptop, tablet or another TV on the same Wi-Fi. `POST /api/movie-night/tv/create` is deliberately **not** used: a room made that way can only be drawn by the page that holds
its ticket. Drawing the lobby natively (poll `/movie-night-api/poll`) is a follow-up.

## Paging and memory

* Library lists come 56 titles at a time from `/api/v1/library/*`; the next page is requested when
  focus is within 14 items of the end. Scene-graph nodes are only built for what has arrived.
* On an older server (no `/api/v1`) the one unpaged list is fetched, **trimmed on the task thread**
  to a few fields (overviews cut to 700 chars) and then paged into nodes 56 at a time.
* Posters are 210x315 cells with `loadWidth/Height` set; the backdrop is decoded at 960x540.
* Search asks for 40 movies + 40 shows.

## Security

* Bearer token lives in `roRegistrySection("beebo")` (private to the channel; the Roku has no
  encrypted store), is attached only to requests for the configured server, never logged, never put
  in a URL, and is removed on sign-out or when the server answers 401.
* https requests use the Roku CA bundle with peer + host verification on.
* Typed passwords are only sent to `/api/login`, and the field is cleared after sending.
* No secrets in the repo (`mock-server.mjs` has a fake token for its own use).

## Restyling

Colors, fonts and layout numbers are all in `components/lib/Theme.brs`; XML files carry structure
only. Placeholder art (`images/PLACEHOLDER_*`, same file names and sizes to replace) is generated
by `npm run placeholders`. Roku certification bits done: channel name, launch-complete beacon, FHD
manifest, title-safe margins, no Roku marks. Not done: real icon/splash art, deep linking, Roku Search
integration, a content-metadata feed.

## What was verified

* **BrighterScript lint** (`npm run lint`): every `.brs` and `.xml` (script paths, component
  inheritance, undefined functions, scope clashes): **0 diagnostics**. Build produces a valid zip with
  `manifest` at the root.
* **Unit tests** (`npm test`): 200+ checks of the pure logic (URL/address policy, formatting, paging,
  redaction, the pairing contract parser and state machine, playback decisions, JSON trimming, LAN
  discovery helpers) run by the `brs` BrightScript interpreter against the *real* lib files. This
  found two real bugs (reserved words `pos`/`m` used as variable names).
* **Smoke run in a third-party Roku simulator** (`brs-engine` 2.6, scratch install, *not* a project
  dependency) against `tools/mock-server.mjs`: Home rows, Movies grid (paged v1 request), TV shows
  and episodes, detail -> audio/subtitle pickers -> play, playlist queue, search, progress + stop
  calls, and the pairing screen against a mock `/tvpair` all issued the expected requests with no
  BrightScript errors. It also caught a real bug (a firmware/simulator difference in `type()` names
  made JSON integers look like non-numbers; number/string/boolean checks now match on the type
  family). A simulator is not a Roku: it cannot show me the screen, run the Video node, or judge layout.

## What is not verified

* **Added with the home-theatre work (none of it has run on a Roku):** the device profile as `roDeviceInfo` really answers it (the exact keys of `CanDecodeVideo` / `CanDecodeAudio` / `GetDisplayProperties` are from the documentation), whether a direct play of an MKV
  or a repackaged fMP4 HLS stream plays and seeks on each model, the fall back after a Video-node error, the Movie Night tab layout, and the whole `POST /api/viewer-session` round trip (unit-tested for the contract, never run against a server).

Everything that needs a real Roku: actual rendering and layout (RowList row geometry, label
truncation, focus ring look, safe zones), remote-key behaviour and focus hand-offs, the on-screen
keyboard/`StandardKeyboardDialog` (password mode), MiniKeyboard voice entry, HLS playback and seeking,
external WebVTT subtitles, https certificate checks against `home.beebo.tv`, LAN-scan speed and
`AsyncCancel` behaviour, memory on low-end models, and the tvpair flow against the live Worker.
**Nothing was run on a real Roku.**

## Top risks (test these first)

1. **HLS playback** of the server's transcode on a real Roku: start, seek (the server starts ffmpeg at
   the requested segment; first segment after a seek can be slow), resume position, 1080p on a
   low-end stick. Fallback in the UI: "Try a lower quality".
2. **Phone-code sign-in** now ends at `POST /api/viewer-session`: try it against a real server with `BEEBO_TVPAIR_ENABLED=1` on the Worker. Username/password still works.
3. **Subtitles**: external WebVTT via `content.SubtitleConfig` is untested; Roku may want `SubtitleTracks`.
4. **Home rows (`RowList`)**: item/label geometry is my best reading of the RowList fields; check it
   first (sizes are in `HomeView.brs` init + `Theme.brs`).
5. **LAN scan**: 253 short probes in batches of 32 with a 25 s hard stop; make sure it is quick and
   does not upset routers. Typing the address always works.
6. **http -> https redirects**: the server 308s plain http to https for non-LAN *names*; check that
   `roUrlTransfer`/`Video` follow that (a typed name is normalised to https so it should not happen).
7. **Password keyboard**: `dialog.textEditBox.secureMode` on `StandardKeyboardDialog`.
8. **Away from home**: `https://<name>.home.beebo.tv:47811` with a real certificate, port forward and
   the plan gate.

## Test checklist (real Roku)

- [ ] Sideload works; icon/splash placeholders show; channel opens to *Connect to your Beebo*.
- [ ] Scan finds the PC (Roku and PC on the same network); typed address works; wrong address shows the friendly error.
- [ ] Sign in with a Beebo user; wrong password shows "didn't match"; lockout message after repeats.
- [ ] Home shows Continue Watching / Recently Added; Movies and TV grids scroll and load more without a stall; Sort (`*`) works.
- [ ] Focus: Up/Down/Left/Right everywhere, Back returns one level, Back on the tab bar exits the channel.
- [ ] Movie detail: Play, Resume, Start over, audio and subtitle pickers.
- [ ] Show detail: seasons/episodes, watched marks, Play/Resume picks the right episode.
- [ ] Playback: starts, OK pauses, FF/RW/replay, seek, Back saves your place (check Continue Watching on the phone), playlist continues to the next item.
- [ ] Kill the server mid-video: friendly error with "Try a lower quality".
- [ ] Sign out (Settings) and back in; sign-in ended by the server returns to the sign-in screen.
- [ ] "Find my Beebo with a code": code shows, the phone approves, the Roku signs in by itself (or says why it could not and offers the typed sign-in).
- [ ] A 4K HDR MKV: the Home theatre plan (check the log line `plan DirectPlay` / `DirectStream` / `Transcode`), HDR shows on an HDR TV, seeking works; an SDR TV gets a tone-mapped conversion.
- [ ] Movie Night tab: status line and the address are right.
- [ ] Search by keyboard and by voice.
- [ ] A 1300+ show library: memory stays flat while scrolling (`telnet <ip> 8085`, `free`).

## Legal

This channel is a client for the user's own media server. It bundles no content and uses no Roku
trademarks. Placeholder images are generated stand-ins, not brand art.
