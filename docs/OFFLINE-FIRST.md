# Offline first: Beebo keeps working when your internet is down

Written 2026-09-21. This is the audit, the fixes, the test that proves it, and the claims the website may make.

The short version: **watching at home never needs the internet.** The library, the accounts, the posters and details
Beebo has already saved, playback (direct and converted), subtitles in your files, music, audiobooks, settings and
the phone apps on your own Wi-Fi all work with the internet gone. Things that talk to other computers by nature
(watching away from home, looking up brand-new titles, updates, signing in to a Beebo account) wait, say so plainly,
and carry on by themselves when the internet is back.

Status: proven by a repeatable test that blocks every public network address (section 6). **Not yet proven with a real
router unplugged, or on a real phone**: that is the owner's five-minute check in section 7, and until it is done the
website should use the wording in section 8 and no stronger.

## 1. What "offline" means here

Two failures look the same to a person and different to a program. The test covers both.

| Mode | What it models | What breaks if the app is careless |
|---|---|---|
| `unreachable` | The polite failure: every name lookup and connection is refused at once. | Ugly error messages, retry storms. |
| `blackhole` | The router is up, Wi-Fi is up, its uplink is dead: nothing is ever answered. | A missing time limit. One request waiting for ever can hold a web page, a sign-in or start-up. |

The blackhole is the real-world one (a dead uplink, a router that swallows DNS questions). It is what found the worst bug
below.

## 2. What was audited

Start-up (`electron/main.js`, `headless/main.js`), sign-in, browsing, and playback, plus everything that runs in the
background. Read from code and then exercised on a real server:

- Licence and plan checks (`license.js`, `licenseToken.js`, `revalidateSchedule.js`, `main.js` around licence status),
  the wallet, the house address, the away-from-home agent, the remote members push.
- Update check and download (`desktopUpdater.js`), Beebo Relay price list (`relayPricing.js`).
- Title look-ups: TMDB, TVmaze, OpenSubtitles, Open Library, trailers/YouTube, radio and podcast directories.
- Every page the server sends (`streamServer.js` and its page modules): third-party fonts, libraries, analytics, images.
- Certificates (`certs.js`), router port opening and STUN (`portMapper.js`), name lookups on the hot path.
- Poster and cast photo storage (`tmdbCache.js`), the "What's new" text (`desktopUpdater.js`, bundled with the update feed).
- The Connection Doctor, Get Started and Settings screens (`src/components`, `connectionDoctorIpc.js`).
- The Android app (`apps/core`): start-up, connecting by home address, the "Can't connect?" screen, Google Play services.

## 3. Results

"Works offline" means: opened and used with the internet unreachable **and** in a blackhole, by `test/offline-e2e.test.js`
(or by a unit test where the piece cannot run headless). Every request answered in under 2 seconds unless noted (converted playback
runs ffmpeg and is bounded generously instead).

| What | Offline? | Why / what it needs | Checked by |
|---|---|---|---|
| First run: setup screen, create the owner account, sign in | Yes | Local accounts. No Beebo account is ever needed to open the library (`SignInGate.jsx`). | e2e, static |
| Web pages: movies, TV, music, audiobooks, photos, playlists, continue, surprise, appearance, account security, get the app, watch page, login, privacy | Yes | All scripts, styles and fonts are inside the app. hls.js is bundled. | e2e (each page scanned for outside resources) |
| Library with saved details and posters, cast photos, TV posters | Yes | Saved on this PC the first time they were fetched (`tmdbCache.js`) and served from disk. | e2e |
| A poster that was never saved | Degrades | The page shows a plain poster shape instead of a broken image (`streamServer.js`, `data-offline-fallback`). It fills in on a later visit once online. | e2e |
| Titles Beebo has never looked up, with a TMDB key saved | Degrades | Listed with the file name and no poster until the internet is back. The page opens at once (see 4, F1). | e2e (blackhole) |
| Backdrop art (wide pictures on a details page) | Partly | Not saved locally. Shown only when the internet is up. Deferred (section 5). | noted |
| Direct playback (Original) and seeking, including by phone | Yes | Streams straight from the PC. | e2e |
| Converted playback (HLS) | Yes | Converted on this PC (ffmpeg). Needs no internet. | e2e (needs ffmpeg) |
| Subtitles in the file or saved next to it | Yes | Local files. | e2e |
| Searching for subtitles online | No, and says so | Needs OpenSubtitles and the owner's key. Answers "not set up" or "offline" at once, within 10 s. | e2e, unit |
| Music, audiobooks (library, streaming, progress) | Yes | Local files. Audiobook details lookup is opt-in and skipped offline. | e2e |
| Settings, dashboard, Get Started, Connection Doctor | Yes | Local. The Doctor now says "No internet right now, but watching at home works." | e2e, unit |
| Phones and TVs on the same Wi-Fi | Yes | Connect by the computer's home address, no name lookup, no cloud. See "Home Wi-Fi mode". | unit, manual |
| Licence for a household that signed in for away-from-home | Kept | A signed token is valid until its own expiry (paid period end + 14 days). A failed renewal removes nothing. Retried in 2, 5, 15, 30, then every 60 min. | e2e, unit |
| Home viewing when the licence is missing, expired or refused | Yes, always | Home is never gated (`localAccessPolicy.js`, `accessStatus().homeAllowed`). | unit |
| Watching away from home, Beebo Relay, BeeboVPN | No | Needs the internet at both ends and a Beebo service. Never covered by any offline grace on the Beebo side. | by design |
| Signing in to or creating a Beebo account | No, and says so | Needs the service. Message: "You may be offline... Your home library keeps working either way." | unit |
| Update check | No, and says so | Needs the website. Silent in the background; a manual check says "you're offline". | reading, unit |
| Certificate renewal | Existing certificate keeps working | Renewal needs the internet, background only, never blocks. Phones using the home address by number need no certificate. | reading |
| Android app on home Wi-Fi with no internet | Yes (by reading; see 5) | Cast starts only when used; no Google Play services needed for local playback; no blocking probes at start-up. | reading |

## 4. What was found and fixed

| # | Finding | Fix |
|---|---|---|
| F1 | **A page could hang for ever.** With a TMDB key saved and the uplink dead, the library page (`/`) never loaded: title look-ups used `fetch` with no time limit, up to 40 of them per page. Found by the blackhole run. | `electron/cloudFetch.js`, installed once for the whole app (`main.js`): a wait limit on every internet request (3 s for cosmetic hosts, 15 s otherwise, ends when the answer starts so downloads are not cut), and a short pause per cosmetic host after a failure, so a page waits once, not forty times. |
| F2 | Twenty-odd bare `fetch` call sites (TMDB, TVmaze, Relay prices, wallet, address, shares, members) each had to remember timeouts. Most did not. | Same global layer: no caller has to remember. |
| F3 | Node runs file reads, sign-ins and DNS on four shared threads. Five look-ups to a dead resolver at once can freeze local pages. | Only one request per cosmetic host is in flight until it has answered once; `UV_THREADPOOL_SIZE=16` at start (`main.js`). The e2e asserts at most two calls wait on one dead host at a time. |
| F4 | The licence renewal ran 8 s after launch even for people who never signed in (sending the install id to beebo.tv), and after a failure waited 12 hours. | `revalidateSchedule.js`: nothing is sent when signed out; after a network failure, retry in 2, 5, 15, 30, then every 60 minutes. |
| F5 | The Connection Doctor called "no internet" a *problem* ("Cannot find beebo.tv") and skipped the check for anyone not signed in. | New verdict: "No internet right now, but watching at home works." A note, not a failure, with the home numbers a phone can type. `connectionDoctor.js`, `connectionDoctorIpc.js`. |
| F6 | The manual update check showed a raw error ("getaddrinfo ENOTFOUND") when offline. | Friendly message: offline, everything at home still works. |
| F7 | A missing poster showed a broken-image icon. | Plain poster shape. |
| F8 | The page security policy still allowed Google Fonts, which nothing used. | Removed, and `offline-static.test.js` now fails on any third-party font, library or analytics host. |
| F9 | The Android "Can't connect?" screen told someone at home with no internet to "check the phone's internet connection". | Adds: at home, use the numbers Beebo shows; they work with no internet (`ConnectionDiagnosis.kt`). |
| F10 | Sign-in error said only "check your internet connection". | Adds that the home library keeps working either way. |
| F11 | Online subtitle search waited up to 20 s. | 10 s. |

New in the desktop app: an **Offline status chip** (Dashboard and Settings) that says "Online", "Works without internet",
or "Offline: home viewing still works", lists what works and what needs the internet, and has a "Check now" button. A
**Home Wi-Fi mode** note under the phone address in Get Started shows how a phone connects with no internet.

### Licence offline grace (what it is and is not)

The licence service signs a token whose expiry is the end of the paid period plus 14 days (`GRACE_DAYS`, `worker/worker.js`).
The app verifies that signature offline and serves until that time. That **is** the offline grace: nothing on the customer's
side can extend it, edit it, or copy it to another PC (device-bound, signature-checked). A failed renewal changes nothing.
Beebo Relay and the paid connection need the service to hand out credentials, so they cannot be obtained offline whatever
the local clock says. Home viewing is free and never looks at the licence.

## 5. Not fixed (deferred), and what is not proven

- **Backdrop art is not saved locally.** Details pages show no wide picture offline. A future "Download all TMDB info" could
  save w780 backdrops (about 60 KB each). Needs an owner decision on disk use.
- **The first page load after the internet dies mid-session can take up to about 3 seconds once** if it shows a title Beebo has
  never looked up, and a TMDB key is saved. After that, and on any computer that starts offline, it is instant. (A quiet
  connection check at start-up and every 8 s while offline shortens this; see `createInternetProbe`.)
- **New words are English only.** The chip, the Home Wi-Fi note and the Doctor's offline wording are in
  `electron/offlineStatus.js` and `src/lib/connectionDoctor.js` (English, like the Doctor's other check names). Translating them
  is one file each. Kept out of the language catalogs to avoid merge conflicts with the i18n work.
- **The Android change is a text edit plus one new unit test, not compiled or run here** (Gradle needs JDK 17 and a lot of CPU).
  Run `android-unit-tests.sh` before the next release. The Android app was audited by reading, not with a phone on an unplugged router.
- **Features that are internet by nature** (podcasts, internet radio, Live TV guide data, trailers, game server downloads, migration
  from Plex) keep their own time limits (15 s in `outboundFetch.js`) and error messages; they were not each tested offline.
- **Local clock rollback** could extend the local "plan valid" flag past the token's expiry. It cannot get Relay or VPN
  (the service decides those) and never affects home viewing.
- **A phone that uses `name.home.beebo.tv` at home needs DNS**, so it fails with no internet. Use the home address (numbers).
  The Android Doctor now says so.
- **The Windows app itself** (window, tray, installer) is exercised through the same `main.js` via the headless shim, not with a
  real window. The chip and hint compile into the renderer bundle (checked with esbuild, since `vite build` needs the app's own
  `node_modules` folder, which a git worktree does not have) but need the manual check below and a real `vite build` before release.
- **Machine load.** The test stretches its 2-second limit up to 4x on a PC that is busy with other work, and uses software video
  encoding (a shared Intel Quick Sync encoder can take minutes to start a first segment on a busy PC, which is not an internet matter).
- **Real router unplugged**: not done. See the checklist in section 7.

## 6. Running the offline test

From `desktop/apps/desktop` (in a git worktree, point `NODE_PATH` at a `node_modules` folder that has the app's dependencies;
do not create junctions):

```
node --test test/offline-e2e.test.js         # internet unreachable: the whole household scenario, plus the Connection Doctor (about 40 s)
node --test test/offline-blackhole.test.js   # uplink dead, nothing answers, TMDB key saved: nothing may wait for ever (about 40 s)
node --test test/offline-signed-in.test.js   # signed in for away-from-home: plan kept, renewal retried soon (about 30 s)
                                             # (all three use ffmpeg if present; each starts a real server, so run them one at a time)
node --test test/offline-static.test.js      # no outside fonts/libraries; every outside address is on a reviewed list
node --test test/offline-doctor.test.js      # Connection Doctor and the chip
node --test test/offline-license.test.js     # licence offline, renewal schedule
node --test test/cloud-fetch.test.js test/cloud-fetch-probe.test.js
```

What these tests do (the shared scenario is `test/helpers/offlineScenario.js`, the server launcher `test/helpers/offlineHarness.js`):

1. Starts the real headless server (`headless/main.js`, the same `electron/main.js` the desktop app runs) with a preload,
   `test/helpers/offlineGuard.js`, that refuses every connection, name lookup and UDP packet to a public address (loopback,
   private ranges, link-local and multicast are left alone) and logs each attempt. The preload is inherited by child processes.
2. Builds a small library: a real movie clip, a subtitle file, a TV episode, a song, an audiobook, and a saved metadata folder.
3. First run and sign-in with a local account; every browse page, poster and cast photo; playback info, direct stream with a
   range request, converted HLS playlist and segment; subtitles; music; audiobooks; the owner's settings screens.
4. Asserts each answer is under 2 seconds (stretched up to 4x on a machine that is busy with other work; the steps that run ffmpeg,
   playback info and the first converted segment, get a generous ceiling because a busy PC can take a minute to look at its video encoders),
   that no page loads anything from another site (except a TMDB poster that was never saved), and that only the listed hosts
   were even attempted (`ALLOWED_OUTBOUND` in the test: the Relay price list; plus Beebo's own service for the signed-in run).
5. In blackhole mode: every call that got no answer was ended by a timeout, and never more than two waited on one host.
6. A signed-in household with a valid token: home works, the token is kept, the renewal retry is scheduled.
7. The Connection Doctor against the live port with the internet blocked.

The test is not vacuous: with `cloudFetch` switched off in `main.js`, `offline-blackhole.test.js` fails with the original bug
(`request to / did not answer within 20000 ms`).

The log of everything the server tried to reach is a file (`outbound-attempts.jsonl` in the test's temp folder); the test prints a
summary line for each run. To use the guard on anything else:
`node --require test/helpers/offlineGuard.js your-script.js` with `BEEBO_OFFLINE=1`, `BEEBO_OFFLINE_MODE=unreachable|blackhole`,
`BEEBO_OFFLINE_LOG=file`, and `BEEBO_OFFLINE_ALLOW=host1,host2` for hosts to leave open.

Adding a new internet call: give it a wait limit (plain `fetch` gets one for free), make the page or feature work without the
answer, add its host to `CONTACTED` in `test/offline-static.test.js` and to the table above.

## 7. Five-minute "router unplugged" checklist for the owner

The test above cannot pull a real cable. Do this once before advertising the claim, and after any big release.

1. On the Beebo PC, note the address in Get Started (something like `192.168.1.20:47811`). Have a phone on the same Wi-Fi with the Beebo app signed in.
2. Unplug the **internet cable from the router** (the WAN port), or turn off the modem. Leave the Wi-Fi router itself on. Wait 30 seconds.
3. On the PC, open Beebo. It should open at once. The chip on the Dashboard should say **"Offline: home viewing still works"** within a minute
   (press "Check now" if you are impatient). Open Settings and Get Started: the Home Wi-Fi note should show your number.
4. Open Movies. Posters and details for titles you have already seen should be there. Play a movie, seek forward, turn on subtitles.
5. On the phone: kill and reopen the Beebo app, choose Home, and type the numbers from step 1. Play a movie and a song. (If the app was saved
   with a `name.beebo.tv` address, use the numbers instead: a name needs the internet.)
6. Press **Can't connect? Fix it for me** on the PC. It should say **"No internet right now, but watching at home works."**
7. Plug the cable back in. Within about a minute the chip should say "Online". Nothing needs restarting.

Note anything that took more than a few seconds or showed an error, and send it along.

## 8. What the website may say

Safe, because it is tested (`test/offline-e2e.test.js`) or true by design:

- "Watching at home never needs the internet."
- "Your library, your accounts and your phones and TVs on the same Wi-Fi keep working when your internet is down."
- "Beebo does not need a Beebo account, or the cloud, to play your own movies at home."
- "Posters, cast photos and details Beebo has already saved to your computer keep showing with no internet."
- "No fonts, scripts or trackers are loaded from other websites."
- "If your internet is out, Beebo says so and tells you what still works."

Say only with the qualifier: "Away from home, updates, and looking up brand-new titles need the internet."

Do **not** say:

- "Everything works offline" or "works with no internet at all" without the qualifier above (away-from-home, Relay and updates do not).
- "Nothing ever leaves your computer" (a TMDB key, updates, sign-in and the price list do talk to other computers, and the licence renewal for signed-in households).
- That backdrop pictures, first-time title look-ups or online subtitles work offline.
- Anything about the Android app that the manual checklist has not confirmed on a real phone.
- That it has been tested with a real router unplugged, until the owner has done step 7 above.

Use the status labels from `CLAUDE.md` section 9: this feature is **Available** for Windows, **Beta** for the phone app's home connection until the checklist is done.
