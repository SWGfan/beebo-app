# Beebo on Amazon Fire TV and Fire tablets

Fire OS is Android underneath, so the same app runs on Fire TV sticks, the Fire TV Cube, Fire TV
Edition televisions and Fire tablets. What Fire OS does **not** have is Google Play services, and
Amazon distributes through its own Appstore. This page is the plan, the sideload steps, and the
Appstore checklist. Nothing here has been run on a real Fire device yet: see
[Not verified](#not-verified-no-fire-device-yet).

## Which devices

Amazon's Fire OS overview
([developer.amazon.com/docs/fire-tv/fire-os-overview.html](https://developer.amazon.com/docs/fire-tv/fire-os-overview.html))
gives the Android base of each Fire OS release:

| Fire OS | Android base | Runs Beebo? |
|---|---|---|
| 5 | 5.1 (API 22) | No. The app needs API 24 (`minSdk`). Fire TV Stick 1st gen and old Fire tablets. |
| 6 | 7.1 (API 25) | Yes. |
| 7 | 9 (API 28) | Yes. Fire TV Stick 4K / 4K Max (1st gen), Stick 3rd gen, Cube 2nd gen, most Fire HD tablets. |
| 8 | 10 / 11 (API 29-30) | Yes. Stick 4K / 4K Max (2nd gen), Cube 3rd gen, Fire TV Omni. |
| 14 / 16 | Android 14 / 15-16 | Yes, in principle (newer televisions). |
| **Vega OS** | Not Android | **No.** Amazon's newest low-end sticks run Vega OS (Linux, React Native apps). An APK cannot be installed. The overview page lists the Fire TV Stick HD (2026) as Vega OS 1.1. |

Which model has which OS is from memory except where the table above says otherwise: check the
device's Settings > My Fire TV > About before promising anything to a customer.

## The `amazon` build

One more product flavour in the existing `distribution` dimension of
`apps/core/app/build.gradle.kts` (`web`, `play`, `amazon`). Same `applicationId`, same code.

| | `web` | `play` | `amazon` |
|---|---|---|---|
| Sold through | website (sideload) | Google Play | Amazon Appstore, or sideload on a Fire device |
| BeeboBook | yes | no | no |
| Google Cast SDK | yes | yes | **no** (no-op `NoCastSupport`) |
| Play Billing | no | yes | no |
| Any `com.google.android.gms` library | yes (Cast) | yes | **none, enforced by `checkAmazonDebugPolicy`** |
| `BuildConfig.IS_PLAY_BUILD` | false | true | **true** (read it as "store build": consumption-only rules) |
| `BuildConfig.IS_AMAZON_BUILD` | false | false | true |
| `BuildConfig.FEATURE_IN_APP_PURCHASES` | false | true | false |

The `web` build (the APK on the website) also installs and runs on Fire OS. Cast is hidden there
too, because the app already checks for Google Play services at run time. The `amazon` build exists
so the Appstore listing carries no Google Play services libraries at all, which is what Amazon's
own review flags.

Source layout under `apps/core/app/src/`:

- `main/` shared code. `player/CastSupport.kt` is the Cast facade: `interface CastSupport`,
  `CastReceiver`, the `CastHelper` object every screen calls, `CastAvailability` (the decision, unit
  tested) and `PlayServices.isAvailable(context)`. **No Google type appears in any signature.**
- `cast/` the real Google Cast code (`GmsCastSupport`, `CastOptionsProvider`,
  `CastMetadataConverter`). Added as a source directory to `web` and `play` only.
- `amazon/` `NoCastSupport`, the amazon manifest overlay, `DistributionFeatures` (BeeboBook stubs)
  and `HouseholdPlanScreen` (the manage-on-the-website line).
- `testAmazon/` tests that only run for amazon.

### What breaks without Google Play services, and what we did

| Feature | Without Google Play services | Handled by |
|---|---|---|
| **Google Cast** (`play-services-cast-framework`, `media3-cast`) | The SDK cannot initialise. Before this change the app already guarded it (`GoogleApiAvailability` check, then `CastContext` in a `try`), so `web` and `play` stayed safe. But the Cast classes were still packaged. | amazon: not linked. `CastHelper` -> `NoCastSupport` answers "unavailable" to everything, so the Cast button, the "casting to your TV" overlay, the Photos "send to TV" action and the playback service's cast player all take their existing "no Cast on this device" path. The manifest entry `OPTIONS_PROVIDER_CLASS_NAME` is removed by the overlay. |
| **MediaRouter** | `androidx.mediarouter` is plain AndroidX and works everywhere. Kept, because `activity_player.xml` and the app bar inflate `MediaRouteButton`. | The button is never made visible without a Cast route selector. |
| **Play Billing** | Not present, and never linked into `web` either. | `playImplementation` only. amazon shows `TvFeatures.MANAGE_ON_PHONE_MESSAGE` on Fire tablets as well as TVs (`FEATURE_IN_APP_PURCHASES` false). |
| **Firebase / FCM** | Not used anywhere. | Nothing to do. The guard rejects `com.google.firebase`. |
| **Location** | Uses the platform `LocationManager`, not the fused provider. Phone-only features (Campsite, Scavenger Hunt) are hidden on a TV anyway. | Nothing to do. |
| **Watch Next row / Google TV search** | Fire TV has no Android TV home-channel provider. `WatchNextSync` is wrapped in `runCatching` and only runs on a TV, so the insert fails quietly. `TvSearchProvider` is never asked. | Harmless. No Fire equivalent is built (see below). |
| **Google Assistant App Actions / voice** | Not on Fire OS. | Left out. Alexa integration is not built. |
| **QR code scanning** (sign-in screen, `scan/`) | The play build's scanner is Google's code scanner, which needs Google Play services. Fire TV has no camera anyway. | The play scanner is `playImplementation` only. amazon has its own `rememberQrScanner` (src/amazon/.../scan) that reports "unavailable", so no CAMERA permission and no camera library ships. The sign-in screen already hides the button on a TV, which signs in with the on-screen code (`tvpair/`). On a Fire **tablet** the button is still shown and answers with the "use the camera app or Paste" message; a follow-up is a CameraX scanner in amazon (copy of src/web's, plus `amazonImplementation` camera deps and CAMERA in the overlay, whose optional camera features are already declared). |

### For anyone adding a Play-services-backed library

The amazon guard fails the build (`checkAmazonDebugPolicy`, which `testAmazonDebugUnitTest` and so
CI depend on) if any artifact in group `com.google.android.gms`, `com.android.billingclient` or
`com.google.firebase` reaches the amazon runtime classpath, or the merged manifest names Google
Play services. To use one:

1. Declare it as `webImplementation(...)` and `playImplementation(...)`, never `implementation(...)`.
2. Put the code that calls it in `src/cast/java` (shared by web and play) or `src/web` + `src/play`,
   behind an interface in `main/` with a no-op in `src/amazon`, the way `CastSupport` does.
3. Before calling it at run time, check `PlayServices.isAvailable(context)`.

If a camera scanner is ever wanted on Fire tablets, use CameraX plus the ZXing decoder already
in the app (what src/web does), not Google's code scanner or the Play-services ML Kit artifacts.
Any `CAMERA` permission needs `<uses-feature android:name="android.hardware.camera" android:required="false"/>`
(and `...autofocus`) or Amazon hides the app from every Fire TV: the amazon overlay already declares
both and the guard checks it.

## Remote control

Fire TV remotes send ordinary Android key events
([Amazon: remote input](https://developer.amazon.com/docs/fire-tv/remote-input.html)):

| Fire remote button | Key event | In the player (`PlayerRemoteKeys`) |
|---|---|---|
| Select | `KEYCODE_DPAD_CENTER` | reveals the controls (PlayerView), select on a focused control |
| D-pad | `KEYCODE_DPAD_*` | left/right seek 10 s while the controls are hidden; move focus once they are up |
| Back | `KEYCODE_BACK` | hides the controls first, a second press leaves |
| Play/Pause | `KEYCODE_MEDIA_PLAY_PAUSE` | toggles playback |
| Rewind / Fast-forward | `KEYCODE_MEDIA_REWIND` / `_FAST_FORWARD` | seek back / forward 10 s (also while held, and with the controls up) |
| Menu (three lines) | `KEYCODE_MENU` | **new:** brings up the controls when hidden (it did nothing before). In lists it is the "details" long-press. |
| Home | consumed by the system | n/a |

Amazon's own note is that Play/Pause, Rewind and Fast-forward may be missing on some remotes, so
everything is also reachable by D-pad alone, which it was already. Amazon's test criteria also look for
a visible focus state on every item and no focus traps: both come from `TvFocusIndication`.

`TvDetection` now also treats the `amazon.hardware.fire_tv` system feature as a TV, in addition to
the television UI mode and the leanback feature. A Fire tablet is none of those and gets the phone
UI (touch, bottom navigation).

## Sideloading (no Appstore)

Works today with the `web` APK from the website, and the same way with an `amazon` build.

### Downloader app (nothing but the remote)

1. On the Fire TV: Settings > My Fire TV > Developer options, turn on **Install unknown apps** for
   Downloader (older Fire OS: turn on **Apps from Unknown Sources**). If Developer options is not
   listed: Settings > My Fire TV > About, press Select on the device name seven times.
2. Install **Downloader** (by AFTVnews) from the Fire TV Appstore.
3. Open Downloader, in the URL box type the address of the APK on the website (currently
   `https://www.beeboentertainment.com/downloads/BeeboEntertainment.apk`; a short link on the
   site would be easier to type with a remote), then Go, then Install.
4. Open Beebo from Your Apps & Channels. It signs in with the on-screen code (Link a TV).

### adb from a computer

Steps from [Amazon: connect adb to a Fire TV](https://developer.amazon.com/docs/fire-tv/connecting-adb-to-device.html):

1. Settings > My Fire TV > Developer options: turn on **ADB debugging** and **Apps from Unknown Sources**.
2. Find the IP: Settings > My Fire TV > About > Network.
3. On the computer (same network): `adb connect <ip>:5555`, accept "Always allow from this computer" on the TV.
4. `adb install -r BeeboEntertainment.apk` (for a build from this repo:
   `apps/core/app/build/outputs/apk/amazon/debug/app-amazon-debug.apk`).
5. Launch: `adb shell monkey -p com.beeboentertainment.movie -c android.intent.category.LEANBACK_LAUNCHER 1`

A sideloaded copy signed with a different key than the Appstore's cannot be updated over each other
(Android refuses); uninstall first when switching.

## Building and testing

```
# JDK 17, ANDROID_HOME set
cd apps/core
./gradlew :app:testAmazonDebugUnitTest :app:assembleAmazonDebug      # includes checkAmazonDebugPolicy
./gradlew :app:checkAmazonPolicy                                     # debug + release guards
./gradlew :app:assembleAmazonRelease                                 # minified; signing as for the other flavours
```

`checkAmazonDebugPolicy` / `checkAmazonReleasePolicy` are the amazon twins of `checkPlayDebugPolicy`
and apply the same rules (no BeeboBook, no prices, no "Subscribe", no child-directed wording, in the merged
manifest, resources and assets) plus the Fire OS rules: no Google Play services library on the runtime
classpath or in the merged manifest, and no required hardware feature (including features implied by a
permission such as `CAMERA`).

## Amazon Appstore submission checklist

Sources: [Submitting apps](https://developer.amazon.com/docs/app-submission/submitting-apps-to-amazon-appstore.html),
[Appstore details](https://developer.amazon.com/docs/app-submission/appstore-details.html),
[Test criteria](https://developer.amazon.com/docs/app-testing/test-criteria.html),
[Content policy](https://developer.amazon.com/docs/policy-center/understanding-content-policy.html),
[IAP overview](https://developer.amazon.com/docs/in-app-purchasing/iap-overview.html).
Read on 2026-09-21; Amazon changes these pages, so recheck before submitting.

**Account and file**

- [ ] Free Amazon developer account (developer.amazon.com), tax and payout details only if the app is paid.
- [ ] Build `amazonRelease` (APK or AAB). Version code above every earlier Amazon upload. (The Appstore
      accepts an APK or AAB; check whether it re-signs, and whether you want its DRM wrapper: not verified.)
- [ ] A physical Fire TV and a Fire tablet to test on. Amazon's own guidance is that testing on a
      real device is essential.
- [ ] Step 1 Upload the file, Step 2 Target the app (Fire TV, Fire tablets; Amazon lists device
      compatibility from the manifest, so `touchscreen` and `leanback` must stay `required="false"`), Step 3
      Appstore details, Step 4 Review and submit. The first three need a green tick.

**Store listing** (from the Appstore details page)

- [ ] Title, short description (up to 2,000 bytes, about 1,200 English characters), long description (up
      to 4,000 characters), 3 to 5 feature bullets, keywords (optional).
- [ ] Fire TV images: app icon **1280 x 720**, **3 to 10 screenshots at 1920 x 1080** (landscape), background
      image **1920 x 1080**. (The 1280x720 `tv_banner.png` already in the app is the right size for the icon.)
- [ ] Fire tablet images: small icon 114 x 114, large icon 512 x 512, 3 to 10 screenshots (800x480 up to
      2560x1600), optional 1024 x 500 promotional image.
- [ ] Content rating questionnaire, support contact, privacy policy URL (`docs/privacy.html` is published on the site).
- [ ] Description wording: reuse `docs/PLAY-READINESS.md` (a player for your own library, no catalogue of
      third-party films, nothing sold in the app). Amazon's content policy rejects apps that infringe a third
      party's IP, so say plainly that the library lives on the person's own computer.
- [ ] Not directed at children: Amazon has a separate Child-Directed App (COPPA) policy. The store builds
      leave BeeboBook out and the guard blocks child-directed wording.

**Amazon's test criteria that apply** (numbering from the Fire TV group of the test criteria page)

- [ ] 2.x Install size 4 GB or less (Amazon recommends 2 GB or less), installs in about 15 s, sensible loading
      indicators, 55 to 60 fps, stable, no force close when a service is unavailable (Cast and Google
      Play services are simply absent here), exit in about 2 s.
- [ ] 2.11 to 2.14 Visible focus on every item, **no touch-screen-only elements on Fire TV**, no focus traps
      (Cast and the phone-only games are already hidden on a TV: `TvFeatures`), external links must not break the app.
- [ ] 2.15 to 2.19 Playback: UHD/4K, HDR and Dolby Vision, Dolby Atmos, audio focus, HDMI unplug handling. Beebo
      plays what the server sends; test 4K, HDR10 and an audio-only pause on a Stick 4K Max.
- [ ] 4.x Fire TV remote: Select, D-pad in every direction, Home, Back, play/pause/rewind/fast-forward all work.
- [ ] Text readable from about 10 feet; 1080p layout.

**Payments** (unverified: Amazon's monetization policy page could not be fetched)

- [ ] The app sells nothing and shows no price, "Subscribe" or link to a payment page (guard enforced). Confirm in the
      Amazon **Monetization and Advertising policy** whether a consumption-only app whose plan is bought on the
      website is allowed, and whether digital subscriptions must go through Amazon IAP. If they must, the
      Fire build would need Amazon IAP, which is a larger piece of work than this one. Poland and Sweden had
      Fire TV IAP suspended per the IAP overview page.

## Known differences on Fire

- No Cast button anywhere. To watch on a television a Fire TV is the television: play directly.
- No Google Assistant / Google TV search / Watch Next row. **Alexa integration is not built** (would be
  a separate Alexa Video Skill or Fire TV catalog integration; left out on purpose).
- Fire tablets show the phone UI. Household plan says to manage the plan on your phone or at beebo.tv (the
  same line as on a TV) instead of opening a purchase sheet.
- Fire TV has no camera: signing in is by the on-screen code. Photo backup, Campsite, Star Chart, Scavenger Hunt
  and Space Saver are phone-only (`TvFeatures`); downloads are hidden on a TV.
- Picture-in-picture, background audio and the media notification depend on Fire OS behaviour that has not been tested.

## Not verified (no Fire device yet)

- That the app installs, launches and the nav rail focuses on a Fire TV Stick 4K, 4K Max, Cube and a Fire HD tablet.
- That `UiModeManager`/leanback detection reports a TV on every Fire OS build (the `amazon.hardware.fire_tv`
  feature is a fallback, also untested).
- That the Menu key reaches `PlayerActivity.dispatchKeyEvent` before Fire OS uses it, and how Fire OS 6's remote
  reports long-press on Rewind/Fast-forward.
- PiP, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and the media session on Fire OS 6/7/8.
- WebRTC and `armeabi-v7a` on the oldest Fire OS 6 sticks. Fire TV Stick 4K and later are 64-bit capable, but many
  run a 32-bit userland, which is why the app ships both ABIs.
- The Appstore's own review results: signing, DRM wrapping, and the payments question above.
