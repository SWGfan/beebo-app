# Beebo TV - Samsung Tizen and LG webOS client

One dependency-free web app (plain HTML, CSS and vanilla JavaScript, no frameworks, no bundler needed)
that runs on **both** Samsung Tizen TVs and LG webOS TVs, with a thin platform shim for each.
It is a client for the person's **own** Beebo home server: nothing is bundled, nothing is stored on the TV
except an address and a sign-in token.

Status: v0.1, built and exercised in desktop Chrome against a mock server. **It has not run on a real TV yet**
(see "Not verified" and "Test first on a real TV" below).

## Supported TVs

The app is designed for the Chromium 63 web engine of 2019 TVs. The staged packages ship it as one classic
script (currently pure ES5 syntax), so the real floor is lower, but only the first two rows are claimed.

| Platform | Model year | OS | Web engine | Status |
|---|---|---|---|---|
| Samsung Tizen | 2019 and newer | Tizen 5.0+ | Chromium 63+ | **Supported (design target)** |
| LG webOS | 2020 and newer | webOS 5.0+ | Chromium 68+ | **Supported (design target)** |
| Samsung Tizen | 2018 | Tizen 4.0 | Chromium 56 | Should work (ES5 script; needs `required_version="4.0"` in `tizen/config.xml`), untested |
| LG webOS | 2018-2019 | webOS 4.0 / 4.5 | Chromium 53 | Should work, untested |
| Samsung 2017 and older, LG 2017 and older | | Tizen 3.0 and older, webOS 3.x | Chromium 47 and older | **Not supported** (no CSS custom properties) |

Hard requirements of the engine: CSS custom properties (Chromium 49), `Promise`, `Object.assign` (45), HTML5
`<video>` with native HLS, XMLHttpRequest. Nothing newer is used; `npm run lint` fails the build if newer syntax,
built-ins or CSS sneak in (optional chaining, `??`, `replaceAll`, `flat`, `AbortController`, flexbox `gap`,
`aspect-ratio`, `inset`, `:focus-visible`, `min()/max()/clamp()` ...).

## What v1 does

1. **First run.** Connect to the home server: a **device-code pairing** screen (no typing), or a LAN address /
   Beebo name typed on an on-screen keyboard. Then sign in.
2. **Browse.** Home rails (Continue Watching, Recently Added, Movies, TV Shows), full-library Movies and TV Shows grids
   (virtualised: only the rows around the focus exist in the DOM, so 1300+ shows are fine), search with an
   on-screen keyboard, detail page (backdrop, synopsis, year / length / rating, Play / Resume / Start over,
   seasons and episodes).
3. **Play.** HTML5 `<video>` playing the server's transcoded H.264/AAC HLS, seek bar with remote scrubbing, subtitles
   (drawn by the app), audio track and quality picker, progress reporting, resume, up-next.
4. **Remote UX.** Spatial D-pad navigation, visible focus ring, Back exits only from Home, media keys, colour keys
   ignored gracefully, 1920x1080 canvas scaled to 1280x720, 5% overscan-safe margins, no hover, no scrollbars.

## Layout

```
apps/smarttv/
  app/                    the app itself (this folder is what runs; also runs in a desktop browser)
    index.html            entry; ES-module script tag (the build swaps it for one classic script)
    theme.css             ALL colours / fonts / sizes / spacing / focus look: a designer restyles here
    app.css               layout, consumes theme.css only
    js/main.js            bootstrap
    js/pairing.js         device-code pairing seam (contract + state machine + viewer-token exchange)
    js/api.js             XHR client, timeouts, friendly errors, paged library with legacy fallback
    js/util/              DOM-free pure logic: escape, urls, pagination, models, vtt, seek
    js/nav/               spatial.js (pure D-pad maths), keys.js, keyboardLayout.js (pure), focus.js (DOM),
                          gamepad.js (Xbox / game-controller mapping, pure)
    js/screens/           setup (welcome/address/pair/signin), home, library, search, detail, player, settings
    js/platform/          Tizen / webOS / Xbox / browser shim (media-key registration, exit); xbox.js and hls.js are
                          used only by the Xbox build (apps/xbox)
  tizen/                  config.xml + icon (Tizen manifest)
  webos/                  appinfo.json + icons (webOS manifest)
  build.mjs               stages dist/tizen and dist/webos
  tools/                  bundle.mjs (modules -> one script), stage.mjs (the staging step shared with apps/xbox),
                          check-compat.mjs (old-Chromium lint), make-icons.mjs
  dev/mock-server.mjs     fake Beebo server + static host for desktop testing
  test/                   node --test suites
```

## Server routes used (existing Beebo home server, same as the Android app)

`GET /api/ping`, `POST /api/login`, `GET /api/v1/library/movies|tvshows?limit&offset&q` (paged; falls back to
`GET /api/movies|tvshows` on 404/403/405), `GET /api/continue`, `GET /api/recently-added`,
`GET /api/tvshows/<key>/episodes`, `GET /api/playback/info`, `POST /api/playback/start` (H.264/AAC HLS transcode,
1080p / 720p / 480p), `POST /api/playback/stop`, `POST /api/watch-session`, `POST /api/progress`, `GET /api/upnext`,
`GET /subtitles/file` (WebVTT), `GET /media/poster/*` (public artwork), `GET /health`.
Movie Night adds `GET /api/movie-night/status` and `POST /api/movie-night/tv/create` (below).
The home-theatre work adds `POST /api/playback/negotiate` (device profile, below), `GET /api/playback/preroll` and `POST /api/playback/preroll/seen`
(Cinema Mode pre-show), and the Live TV / Audiobooks / Podcasts / Radio bearer routes (below). Every one of those is feature-detected.
Auth is `Authorization: Bearer <token>` only. The token is never put in a URL and never logged
(`test/dom-safety.test.mjs` scans for `console.*` and `?token=`). Playback URLs carry their own signed ticket
(`/hls/<ticket>/index.m3u8`) and media token (`&mt=`), so `<video>` needs no headers. The raw MKV / direct file
routes are never requested. HLS is played natively by Tizen and webOS: **hls.js is not bundled** (see risks if a
model refuses).

## Sign-in and pairing

Contract: `worker/tvPair.js` (merged). `POST https://beebo.tv/tvpair/start` gives a code like `ABCD-EFGH` and the
address where it is typed; the TV polls `POST /tvpair/poll` at the server's `interval` (429 `slow_down` handled).
`404` means the feature is off on the Worker: the app falls back to the typed address.

What "approved" returns is a 12-hour WebRTC **viewer** token plus the house `name`. A TV cannot use that against the
home server's plain HTTP API directly, so the app does two things (all in `js/pairing.js`):

1. Builds the address `https://<name>.home.beebo.tv:47811` (see `docs/HOME-ADDRESS.md`), so nothing is typed.
2. Calls **`POST <server>/api/viewer-session`** with `Authorization: Bearer <viewer token>` and expects
   `200 { token, user, expiresAt, server }`. This route now exists on the desktop server (docs `desktop/apps/desktop/docs/VIEWER-EXCHANGE.md`; the token it returns lives 30 days, not 365; it was a target contract, not
   yet merged when this app was written). The token is only ever sent over https, or over plain http to a private
   LAN address (enforced in `isSafeExchangeOrigin`); it is discarded right after the exchange and never stored.
   On 404 / 401 / 403 / 429 the app falls back to typed **username + password** (`POST /api/login`).

The API token from either path lives in `localStorage` (`beebo.tv.token`). Risk note: anyone with debug access to
the TV could read it. It is per person, revocable by the owner, re-checked by the server on every request, kept out
of URLs and logs, and removed by Settings > Sign out. No password is ever stored.

Addresses: plain `http://` is used only for private LAN addresses (`192.168.x`, `10.x`, `172.16-31.x`,
`169.254.x`, Tailscale `100.64/10`, `localhost`); anything else typed as `http://` is upgraded to `https://`. A bare
name (`nick`) or `nick.beebo.tv` becomes `https://nick.home.beebo.tv:47811`. The default port is 47811.

## Build, package, sideload

```
cd apps/smarttv
npm install          # only devDependency: acorn, used by the compatibility lint and its tests
npm test             # unit tests (node --test)
npm run lint         # old-Chromium compatibility check
npm run build        # -> dist/tizen and dist/webos (git-ignored)
```

`build.mjs` copies `app/`, replaces the ES-module tree with one classic script (`js/app.js`), stamps the
`package.json` version into the manifest and the About row, adds the platform manifest and icons, validates the
manifest rules the vendor tools check late (package id length, icon sizes, required privileges) and writes
`dist/build-report.json` (file list with SHA-256). `--target=tizen|webos` builds one; `--modules` keeps the module tree.

Signed packages cannot be produced here, so the last steps use the vendor CLIs.

### Samsung Tizen (.wgt)

1. Install **Tizen Studio** (with the TV extensions) and create a Samsung author certificate + distributor
   profile in Certificate Manager (Samsung account required). Note the profile name.
2. On the TV: Apps > type `12345` > Developer mode ON, enter the PC's IP address, reboot the TV.
3. Package and install (Tizen Studio CLI is in `tizen-studio/tools/ide/bin`):

```
tizen package -t wgt -s <security-profile-name> -- dist/tizen       # writes dist/tizen/Beebo.wgt
sdb connect <tv-ip>
tizen install -n Beebo.wgt -t <tv-name-from "sdb devices"> -- dist/tizen
tizen run -p BeeboTV001.BeeboTV -t <tv-name>
```

Alternatively import `dist/tizen` in Tizen Studio (Import > Tizen Project) and use Run As > Tizen Web Application.
`widget id`, `tizen:application id` and `package` in `tizen/config.xml` are placeholders; Samsung Seller Office
assigns the real ones on submission (package must stay 10 alphanumeric characters).

### LG webOS (.ipk)

1. Install the webOS TV CLI: `npm install -g @webos-tools/cli`.
2. On the TV install the **Developer Mode** app from the LG Content Store, sign in with an LG developer account,
   switch Dev Mode Status ON and Key Server ON, then note the TV's IP and passphrase.
3. Package and install:

```
ares-setup-device                       # add the TV once: name=tv, host=<tv-ip>, port=9922, user=prisoner
ares-novacom --device tv --getkey       # passphrase from the Developer Mode app
ares-package dist/webos -o dist         # writes dist/tv.beebo.smarttv_<version>_all.ipk
ares-install --device tv dist/tv.beebo.smarttv_0.1.0_all.ipk
ares-launch  --device tv tv.beebo.smarttv
ares-inspect --device tv --app tv.beebo.smarttv --open    # remote Web Inspector for debugging
```

`id` in `webos/appinfo.json` is a placeholder until the Content Store account exists.

## Try it without a TV

```
cd apps/smarttv
node dev/mock-server.mjs        # http://localhost:8080 (PORT=... to change); demo / demo
```

Open it in Chrome, choose "Type my server address", enter `localhost:8080`, sign in `demo` / `demo`, and drive
everything with the arrow keys, Enter and Backspace (Back). Options: `MOCK_SHOWS=1300`, `MOCK_LEGACY=1` (no
`/api/v1`), `MOCK_CORS=1`, `MOCK_SLOW=400`, `APP_DIR=dist/webos` (serve a staged build). To try the pairing screen point
`localStorage['beebo.tv.pairBase']` at the mock. The mock streams a public sample mp4.

## Movie Night (party games with phones)

Home has a **Movie Night** rail with one tile (`screens/movienight.js`). It does not draw the games: the home server serves the
shared screen as a web page (`/movie-night/tv`, see `docs/MOVIE-NIGHT.md`), and the app only

1. asks `GET /api/movie-night/status` whether it is available,
2. starts a room as the signed-in person with `POST /api/movie-night/tv/create` (Bearer token; the reply is
   `{ ok, code, ticket, tvPath: "/movie-night/tv", hash: "k=<ticket>" }`),
3. opens `<server origin>/movie-night/tv#k=<ticket>` in the TV's own web view (`platform.openMovieNight`).

The reply is checked before the TV navigates (`util/movienight.js`): the address is always on the server the person chose,
on exactly that path, with a ticket of the shape the server makes; `platform.openMovieNight` refuses anything else and is the
only navigation in the app (a test pins that). The ticket travels in the fragment, so it is never sent to the server or logged.
Phones join by scanning the QR on that page, on the home Wi-Fi, with no account. The page handles the remote itself (arrow keys,
OK, and Back = 8 / 27 / 10009 / 461, which opens an "End Movie Night?" box; leaving the page returns to the app's Home).

Needs *Settings > Allow TV apps (Samsung/LG) to connect* on (the two Movie Night routes are in the CORS allow-list). Xbox shares this
code; whether the Xbox shell lets the page navigate to the LAN address is unverified. Android TV, Roku and Apple TV wiring is a follow-up
(see `docs/MOVIE-NIGHT.md`).

## Home theatre: what this TV tells the server, and how it follows the answer

Since the home-theatre work (`docs/HOME-THEATER.md`) the app no longer asks only for a converted H.264 stream. When the server has
`POST /api/playback/negotiate` (its `GET /api/playback/info` answer carries a `homeTheater` block: that presence is the feature test) the player
sends this TV's **device profile** in the JSON body and plays whatever the server picks:

| Server plan | What the TV does |
|---|---|
| **DirectPlay** | `<video src="/file?id=...&mt=...">`: the original file over HTTP range requests, nothing converted |
| **DirectStream** | the picture (HDR included) copied into fragmented-MP4 HLS, `/hls/<ticket>/master.m3u8` (hls.js on Xbox; native HLS on Tizen / webOS, see below) |
| **Transcode** | the same H.264 / AAC HLS as before |

An older server (no `homeTheater` block) is played exactly as before with `/api/playback/start`. A "preparing" answer (a big film is read once) is asked again up to
8 times. If the TV refuses a direct play or direct stream (the `<video>` error event), the player goes back **once** to the plain conversion from the same position
and stays there for that title. A chosen audio track always uses the conversion (a direct play cannot switch tracks on every web engine). The OSD line says
"Direct play", "Direct stream" or "Converted", plus the file's own badges ("4K", "Dolby Vision", "Atmos"). Settings has **Play original** (on by default; off = always converted) and a
"This TV plays" line that shows exactly what was declared. The quality picker gains **Original**.

The declaration is built by `app/js/util/deviceProfile.js` from `app/js/platform/capabilities.js`. It is honest by construction (tests pin every rule):

* a codec, container or audio format is listed only when `video.canPlayType` (or `MediaSource.isTypeSupported` on Xbox) says the engine plays it;
* HDR only from a display API: Samsung `webapis.avinfo.isHdrTvSupport()`, LG `webOS.deviceInfo` (`hdr10`, `dolbyVision`, `dolbyAtmos`, `uhd`),
  Xbox / Chromium `matchMedia('(dynamic-range: high)')`. **No answer means `hdr: []` (SDR only): the server tone-maps.** HDR10+ is never claimed
  (no web API reports it); Dolby Vision (profiles 5 and 8) only where webOS reports it; Atmos only where webOS reports it;
* `maxHeight` is 2160 only when the panel is reported as UHD, otherwise 1080;
* **TrueHD, DTS, DTS-HD and DTS:X are never listed** (a web view cannot pass them to a receiver);
* `streaming` is `hls-ts` on the native engines and adds `hls-fmp4` only where hls.js (MSE) plays the stream (Xbox). A native player cannot be asked whether it plays
  fragmented-MP4 HLS, so Samsung / LG TVs get a conversion instead of a repackaged stream until a real TV proves fMP4 HLS works.

The profile travels in the **body** because `X-Beebo-Device-Profile` is not in the CORS allowed-headers list (`docs/TV-APP-CORS.md`).

## Live TV, Audiobooks, Podcasts and Radio (Home rows)

Four extra Home rows that appear **only when the server has the feature and something to show** (a 404, 403, "off" or an empty answer leaves the row hidden; a 401 signs the TV out
as usual). They use the bearer JSON routes documented in `docs/LIVE-TV.md`, `AUDIOBOOKS.md` and `docs/PODCASTS-AND-RADIO.md` (nothing is drawn by the server here):

| Row | Routes | What OK does |
|---|---|---|
| **Live TV** | `GET /api/livetv/status` (enabled and a channel), `GET /api/livetv/channels`, `POST /api/livetv/watch {channel}`, `POST /api/livetv/stop {ticket}` | plays the live HLS playlist; Up / Down change channel (with a short delay so flicking does not tune every one), Left / Right go 30 s back / forward inside the rewind buffer; a busy tuner is said in words. A "See all" tile opens a channel list with now / next |
| **Audiobooks** | `GET /api/audiobooks/continue`, `/books`, `/book/<id>?tokens=1`; `POST /api/audiobooks/book/<id>/progress` | an audio screen: resumes at the saved place (whole-book seconds; multi-file books play part by part), progress every 15 s, Left / Right skip 15 / 30 s, Next / Prev = chapter |
| **Podcasts** | `GET /api/podcasts/continue?tokens=1`, `/latest?tokens=1`; `POST /api/podcasts/episode/<key>/progress` | the same audio screen; started episodes first, then the newest unplayed |
| **Radio** | `GET /api/radio/favorites`, `/recent` (else `/browse` popular: the server makes that call), `POST /api/radio/play?tokens=1`, `GET /api/radio/session/<id>` | a live stream through the server's relay; "now playing" from the station's own metadata every 20 s |

Audio is played by an `<audio>` element from the signed `?mt=` address in the answer (no header needed); the app never follows an address that is not exactly the shape the server makes
(`util/extras.js`, tested). Progress uses **POST** (the server accepts POST as well as PUT) because the TV-app CORS list allows only GET / POST; radio sessions have no DELETE for the same reason
and end when the stream closes. **These four families needed a server change** in `corsPolicy.js` (the exact calls above were added to the allow-list; admin, DVR, rescan and settings routes stay closed): a Samsung / LG / Xbox app
against a server without that change simply shows no extra rows.

## Cinema Mode pre-show

Before a **film** that is not being resumed, the player asks `GET /api/playback/preroll?kind=movie&id=...` (server has it, and the person turned Cinema Mode on for themselves: it is off by default). The owner's own
**local** intro and trailer files play first in the same `<video>` (`/cinema/media/<id>?mt=...`, a plain progressive video); OK skips one, Back skips all, anything that fails is skipped, and each item that really starts is reported
with `POST /api/playback/preroll/seen`. **YouTube items are left out**: their terms allow playing them only in YouTube's own embedded player, which this player is not. The TMDB attribution line
the server sends is not shown on the TV yet.

## Remote keys

Arrows move focus geometrically, OK/Enter selects. Back (Tizen 10009, webOS 461, Backspace / Esc on a desktop):
closes the panel or screen; on Home it exits the app. Player: Left/Right scrub (10 s, accelerating to 2 min;
applied after a short pause so a transcoded stream is not hammered), OK play/pause, Up/Down options
(subtitles, audio, quality), Play / Pause / Stop / Rewind / Fast-forward keys, Info shows the bar. Colour keys and
unknown keys are ignored (volume, channel and digits are left to the TV).

## Xbox

The same app also runs on Xbox One / Series X|S inside a small WebView2 shell: see `apps/xbox` and `docs/XBOX.md`. Game-controller
input (A select, B back, X play/pause, Y search, D-pad/stick focus, LT/RT seek, Menu options) is the pure module
`app/js/nav/gamepad.js`; `keys.js` consults it, so it costs the TV builds nothing. Try it in desktop Chrome with a controller:
`node dev/mock-server.mjs`, then open `http://localhost:8080/?xbox=1`.

## Restyling

Only `app/theme.css` needs to change for a new look: colours, fonts, the type scale, safe margins, poster sizes,
grid columns, the focus ring and animation timing are all custom properties on `:root`. Sizes are px on the
1920x1080 canvas (the app scales the whole canvas to the screen). Keep the old-engine rules in `app.css`.

## Not verified

* **Everything in the three sections above** (device profile, negotiate playback, the four Home rows, the pre-show): exercised only by unit tests with fake TVs, fake XHR and, for the profile format, the real
  `deviceProfile.js` parser from the desktop tree. No real TV, no real server with HDHomeRun / audiobooks / podcasts, no real Cinema Mode. In particular: what `canPlayType` says on each Tizen / webOS generation,
  the names of the Samsung and LG display APIs (written from the vendor documentation), whether a direct play of an MKV or a repackaged fMP4 HLS stream really plays, seeking inside a direct play,
  hls.js with fMP4 on Xbox, live-TV channel flicking on a slow TV, and `<audio>` playback of the relayed radio and of multi-part books.

* **No real TV was used.** Everything was exercised in desktop Chrome (1920x1080 and 1280x720) against the mock.
* Tizen `registerKey`, the exit calls, Back-key behaviour and both manifests are written from the vendor
  documentation, not run.
* HLS `<video>` playback of the real transcoder output on each TV generation.
* Cross-origin access from the packaged app (below).
* `POST /api/viewer-session` and the pairing round trip with the real Worker (`tvpair` is off by default and the
  exchange route was still being built).
* Memory on low-RAM TVs, long sessions, suspend/resume.

## Test first on a real TV (highest risk first)

1. **Can the packaged app reach the server at all (CORS)?** The home server sends no `Access-Control-Allow-*`
   headers on `/api/*` today (checked in `streamServer.js`), and the app's page origin is `file://`. Tizen
   (`<access origin="*">`) and webOS may relax this for packaged apps, but that is unproven. If the first
   screen says it cannot connect to a server that is definitely reachable, this is why. A server-side fix
   (a narrow, opt-in CORS allowance) has been proposed as a separate task; until it lands, real-TV results
   decide whether it is needed.
2. **HLS playback**: does `<video src=".../index.m3u8">` start, seek and resume on Tizen 5.0 and webOS 5? If a model
   refuses, add hls.js (MSE) as a fallback in `js/screens/player.js`; the seam is `video.src = ...`.
3. **`file://` and CSP**: the page sets a Content-Security-Policy meta tag (`'self' file:`); if a TV blocks the
   script or stylesheet, remove the tag from `index.html` first.
4. **Back and media keys**: Tizen needs `registerKey` (done at start-up) and the `tv.inputdevice` privilege;
   webOS Back is 461 with `disableBackHistoryAPI`. Check exit-from-Home on both.
5. **Performance** on the weakest supported TV: focus movement latency in a 1300-title grid, image memory, the
   focus-scale animation (set `--focus-scale: 1` and `--anim-fast: 0ms` in `theme.css` to remove it).
6. **The video layer**: the `<video>` sits outside the scaled stage so no transformed ancestor covers it; check
   the OSD draws over the video and the video is full-screen on 1080p and 720p panels.
7. Subtitle drawing (the app fetches WebVTT by XHR and renders it; picture-based subtitles are not shown).

## Legal

A client for the owner's own server; no content is bundled or hosted. No Samsung or LG trademarks or logos are used
(placeholder icons are generic; platform names appear only as technical identifiers). Samsung's and LG's store
submissions (Seller Office, Content Store) each have their own certification checklist and are separate work.
