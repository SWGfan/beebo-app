# Letting the Samsung / LG TV apps connect (opt-in CORS)

The Samsung Tizen and LG webOS apps (`apps/smarttv`) are web apps packaged onto the TV. Their page
runs from `file://`, so the TV's browser engine treats every call to the home server as
**cross-origin** and hides the answer unless the server sends `Access-Control-Allow-*` headers. The
Beebo home server sends none (the phone, Roku and Apple apps are not browsers), so, unless a TV
model relaxes this for packaged apps, the TV app cannot even get past its first screen.

This is a small, **opt-in** fix. It is off by default.

## The setting

Owner setting `tvAppCors` (boolean, **default off**): Settings > "Allow TV apps (Samsung/LG) to
connect". The TV app's setup screen tells the owner to switch it on. It is a whitelisted key in
`electron/desktopSettingsPolicy.js`, read on every request by `electron/corsPolicy.js` (so it takes
effect at once, no restart), and travels in backups like any setting.

**Off: nothing changes.** No CORS header on any route and `OPTIONS` behaves exactly as before.

## What it does when on

Only for the routes the TV app uses (whole path segments, so `/api/moviesX` does not match):

| Exactly this path | This path and everything beneath it |
| --- | --- |
| `/api/ping`, `/api/login`, `/api/viewer-session`, `/api/continue`, `/api/recently-added`, `/api/progress`, `/api/markers`, `/api/watch-session`, `/api/me`, `/api/upnext`, `/api/episode-context` | `/api/v1`, `/api/tvshows`, `/api/movies`, `/api/playlists`, `/api/playback` |

(`/api/me`, `/api/upnext` and `/api/episode-context` are not in the original list but the TV app
calls them. `/api/me/delete` is deliberately not covered: `/api/me` matches only itself.)

The Samsung / LG / Xbox app's **Live TV, Audiobooks, Podcasts and Radio** rows (2026-09-21) add these, and only these
(all need a Bearer token; anything else under those names, above all `/api/livetv/admin/*`, the DVR, the audiobook
rescan / lookup, and every settings, subscription and recording route, stays without CORS headers):

| Exactly this path | This path and everything beneath it |
| --- | --- |
| `/api/movie-night/status`, `/api/movie-night/tv/create`, `/api/livetv/status`, `/api/livetv/channels`, `/api/livetv/watch`, `/api/livetv/stop`, `/api/audiobooks/status`, `/api/audiobooks/books`, `/api/audiobooks/continue`, `/api/podcasts/status`, `/api/podcasts/latest`, `/api/podcasts/continue`, `/api/radio/status`, `/api/radio/favorites`, `/api/radio/recent`, `/api/radio/browse`, `/api/radio/play` | `/api/audiobooks/book` (one book: detail, progress), `/api/podcasts/episode` (one episode: progress), `/api/radio/session` (one session: now playing) |

The methods stay `GET, POST, OPTIONS`: the TV app saves audiobook progress with `POST .../progress` (the server accepts POST as
well as PUT) and never uses DELETE. The audio itself (`?mt=` media token) and the live-TV pieces (signed ticket in the path) are
played by `<audio>` / `<video>` elements, which need no CORS. The TV app sends its device profile in the JSON **body** of
`POST /api/playback/negotiate`, because `X-Beebo-Device-Profile` is not in the allowed-headers list.

1. **Preflight** (`OPTIONS` with `Origin` and `Access-Control-Request-Method`) to one of those
   routes is answered `204` with
   `Access-Control-Allow-Origin: <the request's Origin>`,
   `Access-Control-Allow-Headers: authorization, content-type, x-beebo-client, x-beebo-download`,
   `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Max-Age: 600`, `Vary: Origin`.
   It is answered before the license gate (a preflight carries no data and a lapsed plan must not
   make the TV think the server is unreachable). A preflight for any other `/api/...` route is a
   plain `404 {"error":"cors_not_allowed"}` with no CORS headers. Admin routes are never allowed.
2. **The real request's answer**, whatever its status (so the TV can read a 401, 402 or 429 and say
   why), gets `Access-Control-Allow-Origin` (echoing the Origin, including the literal string
   `null` that a `file://` page sends) and `Vary: Origin`. The echoed value must look like an origin
   (`scheme://host[:port]`, `file://` or `null`); anything else is not echoed.
3. **Never** `Access-Control-Allow-Credentials`, and never `*`. A browser will not give a
   cross-origin page the answer to a request it sent with cookies, so the cookie session cannot be
   used cross-origin. Only a Bearer token in the `Authorization` header works.
4. A request that carries a **session cookie and no Bearer header** gets no CORS headers at all,
   not even on an allowed route. That is what stops a website from using a browser in which the
   owner is signed in.

Media routes (`/hls/*`, subtitles and thumbnails that use a signed ticket in the URL) need no help:
they carry no cookies and already answer `Access-Control-Allow-Origin: *` on their own
(`playbackApi.js`), with this setting on or off. They are not touched by this module.

## Risk analysis

**What "on" changes.** Any web page can already *send* a request to this server from a browser on
the same network; CORS decides only whether the page may *read the answer*. Switching the setting
on lets a page read answers from the routes above. The origin `null` is not special to the TV:
sandboxed iframes, `data:` pages and redirected requests also send it, so with the setting on **any
website open in a browser on the same LAN (or a browser that can reach the server's address) can
call these routes, without cookies, and read the answers.** What that page can reach:

* **`/api/ping`**: server identity and API version. Discovery only.
* **`/api/login`**: sign-in attempts with a guessed username and password. These already work today
  from any device; CORS only lets the page read the result, which a guesser needs anyway. Attempts
  are rate limited per address, per account and globally (`auth.recordFailedLogin` and
  `checkLockout`). **A hostile page can therefore trigger the lockout**: a script that fires wrong
  passwords at a real username locks that account, and enough failures trip the global failure
  budget for people who are not signing in from an address that already knows them, until the
  window passes. It is a nuisance (a denial of sign-in for the lockout period), not a way in. The
  browser's own address is what gets locked by the per-address budget. The owner sees the failed
  attempts in the Admin tab as usual.
* **`/api/viewer-session`**: needs a valid, unspent, house-specific viewer token in the
  `Authorization` header; every other request gets the same 401. A page that does not hold one
  learns nothing.
* **Everything else on the list** (`/api/v1`, library, playback, progress, and so on) needs a
  Bearer token; without one it answers `401 unauthorized`, with the CORS headers so the TV can read
  it. A page that has no token cannot read a library. A page that has a token was given one by the
  person, and could call the server directly anyway.

**What "on" does not change.** Cookies: a cookie-only request never gets CORS headers, and there
is no `Allow-Credentials`, so a logged-in owner's browser is not usable by a website. Admin,
parental, private vault, school, API-key, settings and file-serving routes get no CORS headers and
their preflights are refused. The header list and methods are exactly what the TV needs.

**Also true.** `POST /api/login` still accepts a JSON body (and, as before, a form-encoded one), so
a hostile page can send the attempt as a "simple" cross-origin request without any preflight:
that is unchanged and not something CORS controls. What the setting adds for such a page is
reading the outcome. Chrome's Private Network Access checks may additionally block a public web
page from reaching a private address; this server does not send `Access-Control-Allow-Private-Network`,
so it does not opt in, but the design does not depend on that.

**Why it is acceptable behind an opt-in.** The exposure is: any site the owner's household visits
can read `ping`, attempt (and read the result of) sign-ins, and provoke the existing lockout. It
exposes no library, no account and no admin function without a credential the page would have to
hold already. The owner turns it on only if they own a Samsung or LG TV; everyone else keeps
today's behaviour. If a TV model turns out not to need it (packaged apps that bypass CORS), leave
it off.

## Not covered

* The Worker-side `/tvpair/*` pairing calls have their own CORS (Worker side, not here).
* Direct HTTPS itself: see [VIEWER-EXCHANGE.md](VIEWER-EXCHANGE.md) for who pays for what.
* The Jellyfin-compatible API and the media-ticket routes keep their own, existing CORS answers.
* Headless / Docker servers read the same `tvAppCors` value from their settings store; there is no
  Settings screen there yet.

## Tests

`test/tv-app-cors.test.js`: setting off (no headers on any route, `OPTIONS` unchanged); on (headers
only on the allow-list, Origin echoed including `null`, no credentials header, cookie-only requests
excluded, preflight `204` with the exact headers for allowed routes and `404` without CORS for
other `/api` routes, admin never); `POST /api/login` from origin `null`; the setting takes effect
without a restart; the media routes are unchanged.
