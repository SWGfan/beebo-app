# Installing Beebo as a web app (iPhone, iPad, any browser)

There is no iOS app yet. The server's built-in web viewer is an installable web app instead.

Code: `desktop/apps/desktop/electron/pwa.js` (manifest, worker, offline page, icons, install helper),
`pwaPolicy.js` (what the worker may touch), icons in `electron/pwa/` (made by `tools/make-pwa-icons.ps1`).
Tests: `test/pwa-policy.test.js`, `test/pwa.test.js`.

## What works where

| Address the phone uses | Add to Home Screen | Offline page | Notes |
|---|---|---|---|
| `https://` with a trusted certificate (DuckDNS, `<name>.home.beebo.tv`, a proxy) | full-screen app | yes | Everything works. Chrome/Edge/Android show a real Install button. |
| `http://192.168.x.x:47811` (home Wi-Fi) | full-screen shortcut | no | Service workers need a secure context, so the page skips it. Manifest and icon still work on iOS. |
| `https://` with the headless server's self-signed certificate | untested | no (untrusted) | Browsers refuse workers on untrusted certificates. |

iOS: Safari, Share, Add to Home Screen. The Home Screen copy keeps its own sign-in.

## Public files (no cookie, no library data)

- `/manifest.webmanifest?theme=<preset>&bg=<rrggbb>`: colours come from the person's theme; both values are validated
  on the way in and out. The link is written into each page by the server, so the manifest fetch needs no cookie.
- `/sw.js` (`Service-Worker-Allowed: /`, `Cache-Control: no-cache`), `/pwa/offline`, `/pwa/*.png`, `/apple-touch-icon*.png`.

## Service worker rules

Cached: the offline page and icons only, in a cache named with the version and a hash of those files.
Never cached, never even answered by the worker: `/api`, any `*-api`, `/hls`, `/watch`, `/tvwatch`, `/file`, `/tvfile`,
downloads, uploads, `.json`, Range requests, non-GET, other origins, and any URL with `mt`, `token`, `ticket`, `sig`,
`key`, `code`, `auth`. Pages always go to the network; only a failed network shows the offline page.
No push, no background sync.

## Icon size

The largest brand image in the repo is the 432 px Android launcher artwork, so the largest icon here is 432 px and the
manifest lists no 512. Supply a 512 or 1024 px master (opaque, full-bleed, subject inside the central 80%) and run the
script with that source to add a 512 entry.
