# Headless Beebo server: feasibility map and design

Goal: run the Beebo media server with no Electron window or tray, on Linux
servers, NAS boxes (Docker), Raspberry Pi (arm64) and headless Windows/Mac.

Entry point: `node headless/main.js` (`npm run headless`). Docker: `docker/`.

## 1. How the desktop app starts the server today

Everything is in `electron/main.js` (about 4500 lines). Nothing about the
server lives in a window; the window is only a Settings UI over IPC.

Module load (top level of main.js), in order:

1. `require('electron')` for `app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, safeStorage, Notification`.
2. `new Store()` (electron-store) is the one settings/data file, `<userData>/config.json`. It holds users, folders, ports, watch history, webhooks, licence token and every secret.
3. `storageDefaults.initialize(store)` seeds `C:\Beebo\...` folders on a brand-new install.
4. `secretSettings.install()` wraps the store so 9 secret keys and the `code`/`codeHash`/`secret` fields of `authUsers`/`webhooks` are encrypted with `safeStorage`.
5. `createLicense({ store, config: { enabled: app.isPackaged, ... } })`. Licence code needs no Electron (crypto, fetch, store); the device id is a random id persisted in the store.
6. Music library, mail, backup, convert queue, game host/join modules are constructed. Their IPC handlers (`ipcMain.handle`, about 400) are only reachable from the renderer.

`app.whenReady().then(...)` (main.js ~770) then does, in order:

| Step | What | Electron needed? |
| --- | --- | --- |
| `secretSettings.migrate()` | encrypt any plaintext secret | safeStorage |
| updater bookkeeping + 4 s later `fetchUpdateStatus` | Windows installer self-update | GUI-only (skipped) |
| `createWindow()`, `createTray()` | GUI | GUI-only (skipped) |
| `storybookRuntime.ensureLibrary` | copies story templates into userData | `app.getPath` |
| `createBeeboInbox()` + start after 6 s | watches the Inbox folder, files new videos | no |
| `startStreamServer({...deps})` | the media server (below) | no |
| `installDashboardHooks()` | server dashboard: version, `app.getAppMetrics()` CPU/memory | `app` |
| `musicLib.start()` | music index | no |
| `createRemoteHost(...)` + start after 6 s | away-from-home peer agent: forks `resources/beebo-rtc-host` (Node + werift) | `app.isPackaged` only |
| `createHomeAddress(...)` | keeps `<name>.home.beebo.tv` pointed at this house | no |
| `walletClient`, `relayController` | Beebo Relay prepaid wallet and relay policy | `Notification` (optional) |
| `createPortMapper` x2 (TCP 47811, UDP 47820-47829) | NAT-PMP/UPnP | no |
| `before-quit` handlers | port-map cleanup, inbox stop, music close, login-state flush | `app.on('before-quit')` |
| `seedWelcomeSample()` | copies a sample clip into the Movies folder | no |
| licence revalidation (only when `license.config.enabled`) | refresh signed token | no |
| `scheduleCertificateWork()` | Let's Encrypt via DuckDNS or `*.home.beebo.tv` (acme-client) | no |
| `convert.ensureWorker` | resume queued format conversions | no |

### The `startStreamServer` dependency object (main.js ~815)

```
port                 getStreamPort()            store 'streamPort' (1024-65535) else 47811
inbox                beeboInbox                 inbox.js instance
getMoviesDir / getTvShowsDir / getAllMoviesDirs / getAllTvShowsDirs
                     store 'moviesDir','extraMoviesDirs','tvShowsDir','extraTvShowsDirs'
getViewerAppDir      store 'viewerAppDir'
getTmdbCacheDir      store 'tmdbCacheDir'
store                the electron-store instance
license              createLicense(...)
planUploadDest / recordUploadEntry   upload landing + history (main.js helpers, store only)
log                  console.log('[stream]', msg)
getCertDir / getCertDomain           store 'certDir' else <userData>/certs; store 'certDomain'
getPublicName        getRemoteName()            signed-in account name
agentSecret          per-run random secret shared with the remote-host child
onLanRequest         Connection wizard hook
onSharesChanged      pushLibraryShares()        posts library shares to beebo.tv
music                musicLib                   musicLibrary.js instance
```

None of these are Electron objects. The library scan (`scanVideoDirsOffThread`
via `catalog.sharedCatalogWalker`, a `worker_threads` worker), the TMDB
match/artwork pipeline (`titleMatch`, `tmdbCache`, `metadataSweep`,
`subtitleSweep`), HLS transcoding (`hlsTranscoder.js`, `playbackApi.js`), mail,
webhooks, history and the settings/admin API all live in `streamServer.js` or
plain modules and use only `store` and Node.

## 2. Every `require('electron')`

| File | Use | Headless |
| --- | --- | --- |
| `electron/main.js` | app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, safeStorage, Notification | stub (shim) |
| `electron/desktopUpdater.js` | app, dialog, BrowserWindow | replaced by a stub module: it downloads and runs the Windows installer, which must never happen on a server |
| `electron/backup.js` (line 175) | `safeStorage` inside try/catch | shim `safeStorage` (round trip of secrets in a backup) |
| `electron/preload.js` | contextBridge, ipcRenderer | GUI-only, never loaded |
| `electron-store` (npm) | `app.getPath('userData')`, `app.getVersion()`, `ipcMain.on` | shim |

`electron/streamServer.js` and the other ~90 modules do not require Electron.

## 3. Approach decision

Considered:

* (a) An `electron` shim for Node, then run the real `electron/main.js`.
* (b) Refactor the non-GUI parts of main.js into a shared module used by both entries.
* (c) A new headless entry that rebuilds the dependency object by hand.

Chosen: (a). main.js is a 4500-line file that other agents are editing daily
(reliability, audio, downloads, intro detection). (b) and (c) would either
conflict with all of that or fork it: (c) has to copy ~2000 lines of scan,
metadata and inbox wiring and would drift. With (a) the headless server runs
exactly the code the desktop runs, so every fix in main.js/streamServer.js
reaches the headless server with no extra work, and the Electron entry is
untouched.

How it works (all in `headless/`, new files):

* `electronShim.js` - a module returned for `require('electron')` by a `Module._load` hook (`installOverrides.js`, which also covers `electron-store`'s own `require('electron')`).
  * `app`: `getPath('userData')` = the data dir, `isPackaged` = true (same licence behaviour as the installed desktop app), `getVersion()` from package.json, `getLocale()`, `getAppMetrics()` from `process.memoryUsage()`, `whenReady()` resolved, `requestSingleInstanceLock()` true, a real event emitter with Electron's `quit()` semantics (emits `before-quit` with a working `preventDefault`, so the port-mapping cleanup that defers quit still works).
  * `ipcMain`: handlers are recorded, never called by a window. `shim.headless.ipc.invoke(channel, ...)` can call one (used by tests).
  * `BrowserWindow`, `Tray`, `Menu`, `Notification`, `nativeImage`: inert objects; nothing is drawn. `dialog` answers "cancelled", `shell.openExternal` logs and returns false.
  * `safeStorage`: see section 5.
* `installOverrides.js` also replaces `electron/desktopUpdater.js` with `stubs/desktopUpdater.js` and, when `BEEBO_UPNP=0`, `createPortMapper` with an inert mapper.
* `config.js` - environment variables and an optional JSON file, validated; bad values stop the boot with every problem listed.
* `main.js` - loads the config, resolves the secret key, seeds the store's folder/port keys (env is the source of truth for those), makes a self-signed HTTPS certificate if none exists, wraps `startStreamServer` (to attach the setup page and to capture the server handle for shutdown), then `require('../electron/main.js')`.
* `setupFlow.js` - first-run owner creation (section 4).
* `shutdown.js` - SIGTERM/SIGINT: `app.quit()` (runs every `before-quit` handler), close the server, exit; hard exit after 10 s; a second signal exits immediately.
* `logRedact.js` - console output goes to stdout/stderr through a redactor (media tokens, `token=`/`password=` query values, Bearer tokens, cookies, `"password":"..."` JSON).

### Seams added to existing files (2, both in `electron/streamServer.js`, 20 lines)

1. `BIND_ADDRESS = process.env.BEEBO_BIND_ADDRESS || '0.0.0.0'` replaces the hard-coded `'0.0.0.0'` in the two `mux.listen` calls and the log line. The desktop never sets the variable, so nothing changes.
2. `addPreRequestHook(fn)` (exported) plus a 5-line loop at the top of `handleRequest`. The desktop registers no hooks. The headless server uses it for the setup page.

`main.js`, `package.json` build config and every other file are untouched.
`package.json` gets one line: the `headless` script.

## 4. First run without a GUI

The desktop creates the owner from its Get Started screen through
`auth.createOwner(store, { username, password })` (IPC `auth:createOwner`),
which already refuses once an owner exists. The web viewer has no owner
creation, and the web admin needs an existing admin.

Headless flow (`headless/setupFlow.js`, pre-request hook):

* While no approved admin exists, the log prints a setup URL and a one-time code (60-bit, random, in memory only, new on every restart).
* `GET /setup` serves a small page; `GET /` from a browser redirects to it.
* `POST /api/headless/setup {code, username, password}` calls `auth.createOwner`.
* Once an owner exists (created here, by the desktop, or restored from a backup) both routes fall through to the normal server and the code is discarded.
* Wrong code: 403. 5 wrong codes lock setup for 10 minutes and rotate the code (printed to the log again). 8 attempts per minute per address. Constant-time comparison, JSON bodies only, same-origin check, 4 KB body limit, no-store and CSP headers. Passwords are at least 8 characters.

## 5. Secret storage

`safeStorage` on Windows/Mac/Linux desktops uses the OS keychain. A server has
none, so the shim (`headless/secretBox.js`) does this:

* AES-256-GCM, key derived with HKDF from a master key. Blobs are `BSS1 | iv | tag | ciphertext`; a wrong key or damaged blob throws, like Electron's.
* Master key, in order: `BEEBO_SECRET_KEY` (at least 32 characters, `openssl rand -hex 32`), `BEEBO_SECRET_KEY_FILE` (Docker secrets), `<data>/secret.key` (generated on first run, mode 0600, permissions verified after writing; if the filesystem cannot hold a 0600 file the boot stops rather than write a readable key).
* No key and no way to make one: the boot stops with instructions. Plaintext secrets need an explicit `BEEBO_ALLOW_PLAINTEXT_SECRETS=1` and print a warning every start.
* `<data>/secret.check` proves the key still matches the data, so a changed or lost key stops the boot with a clear message instead of silently signing everyone out.
* `config.json` (the electron-store file) is written with mode 0600 (a subclass of the store passes `configFileMode`, so no edit to main.js), and `secret.check`/`secret.key`/`certs/key.pem` are 0600 too. The default of the store library is 0666.
* Honest limit: a key file in the same volume as `config.json` only protects against `config.json` leaking on its own (a backup, a support upload). Someone with the whole `/config` volume has the key. Use `BEEBO_SECRET_KEY` or a Docker secret to keep the key off the data volume.

## 6. Licence and sign-in

`license.js` runs unchanged (the device id is a random id stored in the
config, not hardware based). Home use is always free by design; enforcement
only applies to Beebo Relay. What is missing is a screen to sign in: the
desktop does it through IPC (`license:login`, `license:registerTrial`,
`license:activate`) from Settings. The web admin has no equivalent.
So v1 is "LAN plus own address": no `<name>.beebo.tv` name, no away-from-home
P2P agent (it only starts when signed in), no Beebo Relay wallet. Adding an
owner-only sign-in endpoint is a small follow-up (the handlers exist and the
shim can call them).

## 7. Admin needs HTTPS

`/admin` and `/api/admin/*` refuse plain HTTP by design (`adminRequestIsSecure`:
TLS socket or the away-from-home agent). A LAN server has no public
certificate, so the headless server creates a self-signed ECDSA P-256
certificate (`headless/selfSigned.js`, valid 825 days, renewed within 30 days
of expiry) in `<data>/certs` on first run. The certificate is used on the same
port (the existing plain/TLS multiplexer); LAN clients that use an IP address
are still served plain HTTP for viewing, which keeps the phone apps working.
A certificate placed in `certs/` (`cert.pem`, `key.pem`) by the user is never
replaced. `BEEBO_SELF_SIGNED_TLS=0` turns this off.

## 8. Docker and networking

* Bridge mode: port 47811 published; UPnP/NAT-PMP cannot reach the router from a bridged container (set `BEEBO_UPNP=0` to stop trying); DLNA-style discovery does not cross the bridge.
* Host mode (`network_mode: host`): the router mapping works and the container sees the LAN.
* Away-from-home over UDP 47820-47829 (WebRTC) also needs the host network or those ports published, and is only used when signed in (see section 6).

## 9. Things found while building it

* `resolveFf` in `convert.js`/`musicTranscode.js` only looks at `BEEBO_FFMPEG`/`BEEBO_FFPROBE` and `resources/ffmpeg`, not `PATH`. The headless entry finds ffmpeg on `PATH` itself and exports the two variables before anything loads.
* HLS temp files go to `os.tmpdir()`. `BEEBO_TRANSCODE_DIR` sets `TMPDIR`/`TEMP` so a NAS can point them at a tmpfs.
* `main.js` `getCertDomain()` falls back to the domain in `tools/duckdns-update.bat`, which exists in a source checkout. Docker excludes `tools/`, so the image is unaffected; from a checkout the daily certificate check logs one harmless "getting a new one" line and fails for lack of a DuckDNS token. The self-signed certificate is never replaced by a failed attempt.
* The web admin needs HTTPS (section 7), so without a certificate a headless server would have no admin at all.
* `seedWelcomeSample` would copy a sample clip into the user's movie share; headless skips it unless `BEEBO_SEED_SAMPLE=1`.
* Storybook templates (111 MB) and their Python voice tools are not in the image.

## 10. Files and layout

* `headless/` - the entry and shim (above).
* `docker/` - Dockerfile (multi-stage, `node:22-bookworm-slim`, tini, non-root, pinned LGPL ffmpeg from BtbN with SHA-256), entrypoint (`PUID`/`PGID`), compose examples, README.
* `.github/workflows/headless-docker.yml` - build and smoke test, no registry push.
* Tests: `test/headless-*.test.js`.

## 11. Desktop feature status (headless)

See the table in `docker/README.md` ("What works headless").
