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
   `200 { token, user, expiresAt, server }`. This route is being added to the desktop server (target contract, not
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
