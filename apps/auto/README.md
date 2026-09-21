# Beebo Entertainment Auto

A companion Android app that puts your Beebo Entertainment library inside Android Auto's own
media screen — browse, search, and play from the head unit, with progress synced
back to the server so Continue Watching stays in step across the car, the phone
and the website.

It talks to the same `/api/*` contract the existing Beebo Entertainment phone app uses
(`apps/desktop/electron/streamServer.js`, port 47811). It does not replace that
app and does not touch it; it is a separate package, `com.beeboentertainment.auto`,
that can be installed alongside.

## What it can and can't do

Android Auto never hands a media app a drawing surface, so **there is no video**.
This is the platform's rule, not a limitation of this app: media apps get a browse
tree and a media session, and video is a separate app category that is still in
closed early access for Android Auto. What you get in the car is your library,
browsable and searchable on the head unit, playing audio.

For picture on the car screen you need a screen-mirroring solution for your
head unit; that isn't part of this app.

By default the app switches off the video track entirely, so it doesn't decode
frames nobody can see. Turn that off in Settings if you ever want the stream
intact.

## The browse tree

Android Auto asks for at most four browsable root entries, so:

```
Continue Watching     partially-watched titles, with a "N min left" subtitle
Movies                Recently Added | All Movies A-Z | Genres
TV Shows              show -> season -> episode   (A-Z tier above 200 shows)
Surprise Me           ten random picks from the surf endpoint
```

Search is wired up too, including `MEDIA_PLAY_FROM_SEARCH`, so Assistant can hand
the app a query.

## Building

Requires JDK 17+ and an Android SDK with platform 36 and build-tools 36.0.0.

```bash
export ANDROID_HOME=/path/to/android-sdk
./gradlew assembleRelease        # -> app/build/outputs/apk/release/app-release.apk  (~2.4 MB, R8)
./gradlew assembleDebug          # -> app/build/outputs/apk/debug/app-debug.apk      (~22 MB, unminified)
./gradlew testDebugUnitTest      # 92 JVM tests, no device needed
```

Both variants are signed with the same debug key, so one can replace the other on the
phone without uninstalling. The release build runs R8 — `app/proguard-rules.pro` keeps
the four classes the manifest names and the kotlinx-serialization field names the JSON
depends on. If anything ever behaves oddly on release and not on debug, that file is
the first place to look.

Versions that are known to work together: AGP 8.13.2, Gradle 8.14.5,
Kotlin 2.4.10, Compose BOM 2026.06.01, Media3 1.11.0. Compose BOM 2026.08.00 and
later require AGP 9.1+, so don't bump one without the other.

The keystore committed at `debug.keystore` signs both variants. That is fine for
sideloading onto your own phone; it is not fine for the Play Store.

## Installing and setting up

1. Sideload the APK (`adb install -r app-debug.apk`, or copy it over and tap it).
2. Open **Beebo Entertainment Auto** on the phone and sign in the same way as the phone app:
   **Home** (your home's name, like `thesmiths` or `thesmiths.beebo.tv`, or the email of
   whoever pays for Beebo), your username and your password. The car then reaches the home
   computer through the private peer-to-peer connection (`name.beebo.tv`), or straight to its
   own address when on the home Wi-Fi and that address is known. No open router port is needed.
   **Advanced: direct address** is optional: with Home filled in it is the address used at home;
   with Home empty it signs in straight to that address, as setups from before did.
   **Test** checks reachability. The tunnel code is the phone app's own (`apps/core/.../rtc/`),
   synced into this build by `syncSharedRtc` in `app/build.gradle.kts`; the car-specific glue
   is `remote/AutoRemote.kt`.
3. Android Auto hides sideloaded apps until you allow them:
   - Phone Settings › Apps › Android Auto › Additional settings in the app
   - Scroll to About, tap the version line ten times, tap OK
   - Overflow menu (⋮) › Developer settings › **Unknown sources** on
   - Force-stop Android Auto, then reconnect to the car
4. Beebo Entertainment Auto appears in the car's media app list.

Step 3 is Google's documented developer path and it covers media apps
specifically — no Play Store install source is needed for this app.

## Notes on how it works

**Stream tokens.** The server signs each stream URL with an `mt` token good for
twelve hours, and a stale one redirects to an HTML login page rather than
returning 401 — which a player would otherwise try to parse as media. So stream
URLs are resolved at the moment you press play, not when the list was built, the
cached ones expire after an hour, and the player's HTTP client rejects an
`text/html` response with a readable error.

**Artwork.** Browse rows can only show artwork from a `content://` URI — Android
Auto will not fetch a web URL and Media3 passes `artworkUri` through untouched.
`ArtworkProvider` serves posters out of a local cache, fetching them from the
server on demand. It is exported (the car has to reach it), so it validates the
path against a strict allowlist and checks the calling package.

**Cleartext.** Beebo Entertainment is commonly reached over plain HTTP on a home network or
a Tailscale address, so cleartext is permitted. When the server does have a
certificate it answers HTTP with a 308 to HTTPS on the same port and the client
follows that, preserving the method and body — which matters, because a redirect
that downgraded POST to GET would make every progress report silently do nothing.

**Not implemented on purpose.** No admin surface (it is HTTPS-gated server-side
and has no business on a head unit), no downloads, no Cast. The `onConnect`
callback accepts every controller — the browse tree is readable by any app on the
phone. If that matters to you, add a package validator there.

## Shipping an update

The app checks `GET /api/auto-version` on every launch — unauthenticated, so it
works even with an expired token — and shows a Download button when the server
reports a higher `versionCode` than the installed build. It can't install the APK
itself (that needs `REQUEST_INSTALL_PACKAGES`, which it deliberately doesn't
have); the button opens the download in the browser and you tap the file.

To publish a new build:

1. Bump `versionCode` and `versionName` in `app/build.gradle.kts`.
2. `./gradlew assembleRelease`
3. Copy the APK to `apps/desktop/auto-app/JenkinsAPP-Auto.apk` on the server.
4. Edit `apps/desktop/auto-app/version.json` to match, with a one-line `notes`
   describing what changed — that text is what the phone shows.

No server restart is needed for step 3 or 4; the route reads both files per
request. Only a change to `streamServer.js` itself needs Beebo Entertainment restarting.

## The one OkHttp trap in this codebase

`Http` sets `followSslRedirects(false)` and `ApiClient.perform()` handles the
http→https upgrade by hand. That is not stylistic — do not "simplify" it.

Beebo Entertainment serves HTTP and HTTPS on the *same port* (`streamServer.js` peeks the
first byte of each connection and hands the socket to whichever server fits), so
once a certificate is live the plain side answers 308 to a URL that differs only
in scheme. OkHttp cannot follow that: it treats same-host-same-port as a
reusable connection, re-sends the redirected request down the existing cleartext
socket, gets 308'd again, and gives up with `Too many follow-up requests: 21`.
Reproduced end to end against a replica of the server; `curl -L` follows the
same redirect in a single hop, so this is specific to OkHttp meeting a
scheme-only redirect.

`ApiClient.httpsUpgradeTarget` is the pure decision and is unit-tested. The
upgrade is saved to `Prefs.baseUrl`, so posters and video streams inherit it
instead of each paying a wasted round trip.
