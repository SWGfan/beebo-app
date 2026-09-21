# Beebo Auto Family Fun

Status: **In development** (code on a worktree branch, unit-tested, **not run on a real phone, a head unit or the Desktop Head Unit**, not released). Do not describe it as Available until a release contains it and it has been tried in a car or on the DHU.

Package `com.beeboentertainment.auto`, folder `apps/auto/app/src/main/java/com/beeboentertainment/auto/family/`.
Source of the requirements: `_research-camping-roadtrip-hiking-kids-2026-09-21.md` (Trip Clock, Eyes-Up Voice Games, Roadside Stories) and `docs/CAMPSITE-FAMILY-PACK-A.md` (the Trip Clock and Quiet Hours logic this reuses).

Three parent-run features for the Android Auto media app, all audio:

| Feature | In the car | On the phone |
|---|---|---|
| **Trip Clock glance** | One row: "About 3 more movies", with "Estimate only. Use your navigation app for directions." under it. Tap it and the phone reads it aloud. Read-only. | A card to start, push back (+15 min) and stop the clock, when parked or on a passenger's phone. |
| **Voice Games** (20 Questions, Name That Sound, Alphabet Road) | Three rows. Each starts a queue of rounds; the phone's voice leads, passengers answer out loud, the car's Next button skips a round. | Same games, plus a points counter, Pause and Next buttons. |
| **Roadside Stories** | Eight story rows, age band chosen by a parent first. Read aloud in short parts. A "Sleep timer" button on the now-playing screen. | Same, plus sleep timer buttons (15, 30, 45 minutes). |

Everything is **off until a parent turns on "Show Family Fun in the car's list"** on the phone. Voice games in the car are **off again by default** behind a second switch.

---

## 1. What the platform allows (research, 2026-09-21)

Question asked: can a car app do text-to-speech and speech recognition for a game, and what are the driver-safety rules? Pages below were read on 2026-09-21 (the current month; Google changes these pages often, so re-check before a Play submission).

### Sources

1. Android for Cars App Library overview: https://developer.android.com/training/cars/apps
2. Media apps for cars (Android Auto and Android Automotive OS): https://developer.android.com/training/cars/media
3. Support voice actions in a media app: https://developer.android.com/training/cars/media/voice-actions
4. Record from the car microphone (`CarAudioRecord`): https://developer.android.com/training/cars/apps/library/car-microphone
5. Template restrictions: https://developer.android.com/training/cars/apps/library/template-restrictions
6. Distraction safeguards for media apps: https://developer.android.com/training/cars/media/distraction-safeguards
7. Car app quality guidelines (DD, MA, VC, SA, ST, IN, DR rules): https://developer.android.com/docs/quality-guidelines/car-app-quality
8. Build parked apps for cars (video, games, browsers): https://developer.android.com/training/cars/parked
9. Car ready mobile apps program: https://developer.android.com/training/cars/car-ready-mobile-apps
10. Android Developers Blog, "New in-car app experiences" (Google I/O 2025, games on Android Auto): https://android-developers.googleblog.com/2025/05/android-for-cars-google-io-2025.html
11. Android Developers Blog, "What's new in Android for Cars" (May 2026): https://android-developers.googleblog.com/2026/05/android-for-cars-unifying-platforms-premium-experiences.html

The pages were fetched and summarised by an automated reader, not read line by line by a person. Anything marked UNVERIFIED below is a gap in what was returned.

### Findings

- **Categories.** The Car App Library (a `CarAppService` with templates) supports navigation, point of interest, internet of things and weather apps; a templated media category is in early access and communication is in beta [1][2]. There is **no "kids", "family" or "game" category in the template library**. Games are a separate *parked app* category [8].
- **Media apps get no screen of their own.** Android Auto and Android Automotive OS render a standard media browser and now-playing screen from a `MediaBrowserService` / `MediaLibraryService`; custom UI is not allowed; the newer templated media route still needs a `MediaSession` and one of those services behind it [2]. That is exactly what Beebo Auto is (`<uses name="media"/>`). So the only things the car can show are list rows (title, subtitle), the now-playing screen, and custom actions.
- **Non-music audio is a legitimate media item.** The media guide lists "a chapter in an audio book" and "an episode of a podcast" as media items [2]. Stories are the same kind of thing.
- **In-app playback while driving.** "Aside from voice guidance audio for navigation apps and the media apps described here, in-app media playback while driving isn't permitted" [2]. Audio from a media app is the permitted case.
- **Speech recognition: not for a media app.** In a media app the *Assistant* does the listening; the app only receives the interpreted text through `onPlayFromSearch` [3]. "Users can initiate queries by clicking the appropriate buttons on their steering wheel or speaking the hotwords" [3]. A media-browser app has no microphone stream from the car.
- **`CarAudioRecord`** gives a `CarAppService` app access to the car microphone with the normal `RECORD_AUDIO` runtime permission and an audio-focus request [4]. The page does not name which categories may use it (UNVERIFIED), but it belongs to the Car App Library, which Beebo Auto does not use for its browse UI. Using it would also mean recording children's voices.
- **Games as a category** run only while parked, on Android Auto phones with Android 15 and up; the May 2025 post says games were in beta [10] and one search summary dated September 2026 says the category is generally available (UNVERIFIED: the official pages fetched did not say). Video, games and browsers "must not be launchable or usable while driving and must not play any audio" (DD-2, DD-3) [7]. The "Car ready mobile apps" program is invite-only and Android Auto support is "at a later date" [9]. **Beebo Auto is not, and does not declare itself as, a parked app.** Nothing here relies on that program.
- **Media quality rules that matter here** [7]: MA-1 no autoplay without a user action; VC-1 support Gemini/Assistant voice commands; SA-1 no animated elements; ST-1 no automatically scrolling text; IN-1 notifications only when relevant to the driver; DR-1 buttons respond within two seconds; DR-2 launch within ten seconds; DR-3 content loads within ten seconds. Distraction safeguards [6]: media apps must not play audio automatically through the car speakers, including alarms.
- **Template limits.** Five templates deep per task, ending in a message, pane, navigation, media playback, sign-in or long-message template [5]. Not relevant to a browse tree, noted for any future templated version.
- **New in 2026.** Car App Library 1.8 adds `SectionedItemTemplate` and `MediaPlaybackTemplate` for customised media browsing (alpha, then 1.8.0-beta01 in May 2026) [1][11]. Not adopted: it would replace the media browser with a new UI that has never been reviewed in a car.

### Decision that follows

| Question | Answer |
|---|---|
| Speech recognition in the car? | **No.** Not supported for a media-browser app; the alternative would record children's voices. The phone has no `RECORD_AUDIO` permission (a unit test checks the manifest). |
| Then how do the games work? | The phone's own text-to-speech leads. It says a prompt, stays silent for a few seconds while the passengers answer **out loud to each other**, then says the next thing. Each round is its own audio item, so **the car's own Next and Pause buttons** (steering wheel, Assistant "next") are the only controls anyone needs. |
| Any button to tap? | Only on the phone screen, and only when `FamilyGate` says it is safe: a parked Android Automotive car, or a phone that is not projecting to Android Auto and whose user said "I'm a passenger". Never on the car's own list. |
| Text on the car screen? | Short titles (44 characters at most, a test checks every row) and one short line. Nothing scrolls, nothing animates, no artwork. |

---

## 2. What was built

### Shared with the phone app (one copy of the logic)

`app/build.gradle.kts` syncs six pure Kotlin files from `apps/core` into this build at build time, unchanged, in their own package (the same way the WebRTC tunnel code is shared; task `syncSharedFamily`):

`campsite/family/WallClock.kt`, `campsite/family/FamilyPackStorage.kt`, `campsite/quiet/QuietHours.kt`, `campsite/quiet/QuietHoursStore.kt`, `campsite/tripclock/TripClockLogic.kt`, `campsite/tripclock/TripClockStore.kt`.

So the car and the phone cannot disagree about "how long is left" or "is it quiet". Nothing in `apps/core` was changed, so the phone app's tests are unaffected. (The phone app's screens, guest page, GPS progress and wind-down are **not** taken: they are glued to the phone app.)

**The state is not shared between the two apps.** They are separate installs (`com.beeboentertainment.movie` and `com.beeboentertainment.auto`) and one cannot read the other's preferences. The car app keeps its own Trip Clock and quiet-hours settings, set on the phone screen of Beebo Auto. See "Deferred" for the hand-off.

### Files (all under `family/` unless noted)

| File | What it does | Testable on the JVM |
|---|---|---|
| `FamilyGate.kt` | The parked/driving and quiet-hours rule. Built on `VideoGate`, so the app has one answer to "is this a moving car". | yes |
| `TripGlance.kt` | The glance: kid units (movies at 100 min, TV episodes at 22, songs at 3.5), fuzzy words ("a few more songs"), the estimate line, late and arrived states. | yes |
| `VoiceGames.kt`, `FamilyContent.kt` | The three games and their word lists (30 clue items, 24 sound riddles, 24 category prompts, 3 listening rounds, 26 letters with examples). A round is a pure function of game, seed, index and age band. | yes |
| `Stories.kt` | Eight original stories, about 300 words each, three age bands, split into parts of about 110 words. | yes |
| `SleepTimer.kt` | Fade over the last minute (or a fifth of a short timer), then stop. | yes |
| `FamilyIds.kt`, `FamilyMenu.kt`, `FamilyScripts.kt` | The media-id namespace, the folder shape, and "id to what the voice says", with the gate applied at start and again just before speaking. | yes |
| `WavStitcher.kt` | Joins speech clips and silences into one WAV. | yes |
| `FamilyPrefs.kt` | Switches, age band, and the shared quiet-hours and Trip Clock stores, in a small plain preferences file. Also `FamilyRuntime` (in-memory drive signals and the sleep timer). | no |
| `TtsRenderer.kt` | Android `TextToSpeech.synthesizeToFile` per sentence, then `WavStitcher`, into `cacheDir/family-tts/` (40 files kept). Output only. | no |
| `FamilyMedia.kt`, `FamilySession.kt` | Browse rows as Media3 items, the data-source resolver, the sleep-timer button and its fade. | no |
| `FamilyScreen.kt` | The phone screen (Compose). | no |
| `media/PlaybackService.kt` (edited) | Family rows answered without a server; a `ResolvingDataSource` in front of the network source; family audio never reported as watch history. | no |
| `ui/MainActivity.kt` (edited) | Adds the Family Fun section and resets the signals when the screen closes. | no |
| `AndroidManifest.xml` (edited) | `<queries>` for the phone's text-to-speech engines (needed from Android 11). No permission added. | no |

### How the audio reaches the car

1. A parent turns Family Fun on. The car shows a "Family Fun" folder (a seventh root tab on a host that shows seven, otherwise last inside Movies, because most hosts show only four tabs and the four are already used; see `Catalog.rootTabs`).
2. Tapping a story or a game gives the service a row with no address. `onSetMediaItems` / `onAddMediaItems` expand a story into its parts and a game into its rounds, each an item with a `beebo-tts://` address, after applying the gate.
3. When ExoPlayer opens an item, a `ResolvingDataSource` turns the address into a WAV made on the phone by the phone's own speech engine (blocking on the player's loading thread, never the main thread). The next item is prepared while the current one plays, so a round starts quickly after the first.
4. Nothing is fetched from anywhere. The words ship inside the app.

### The games

- **20 Questions (clue edition).** The phone thinks of something, gives five clues from tricky to easy with a gap after each, then says the answer. Six rounds. Passengers guess out loud. (The classic yes/no version needs the phone to hear the questions, which it cannot.)
- **Name That Sound.** Ten rounds: five sound riddles (the phone says the sound in words, "Drip, drip, drip", and passengers name what makes it), three category races with a halfway call ("Name as many round things as you can"), two quiet listening rounds. No recorded sounds: those would need audio rights.
- **Alphabet Road.** A to Z, one round per letter, with two easy example words per letter and a gap for passengers to call things out. The intro says passengers do the looking and drivers only listen.
- Three age bands (4 to 6, 7 to 9, 10 and up) choose the difficulty level of the words and how long the gaps are (1.5 times, 1 times, 0.8 times).
- Every game opens with: "This game is for the passengers. Drivers, keep your eyes on the road and just listen."

### Roadside Stories

Eight stories written for Beebo: *Milo and the Blue Door*, *The Moon Rides Along*, *Bramble Finds a Blanket* (ages 4 to 6); *The Picnic Table at Mile Nine*, *Two Rivers and the Bridge*, *The Lighthouse Keeper's Whistle* (7 to 9); *The Mapmaker's Apprentice*, *The Night Train to Tidewater* (10 and up). Tests check each is 250 to 380 words, has no frightening word or brand, has no digits or symbols a speech engine reads badly, makes no sleep or health claim, and ends on a quiet word. They are stories to listen to. They are not a sleep aid and nothing says they are.

**Sleep timer.** 15, 30 or 45 minutes from the phone, or one "Sleep timer" custom action on the car's now-playing screen that cycles off, 15, 30, 45, off. Full volume until the last minute, a straight-line fade, then pause; volume is put back for next time. It uses the phone's steadily increasing clock (`elapsedRealtime`), so a time or time zone change during a drive cannot stretch it. Nothing can start playing because of the timer. It is a timer and a fade, not a sleep aid.

### Quiet hours

Uses the phone app's own `QuietSettings` and `QuietHours` (default off; presets 9, 10, 11 pm to 6 or 7 am; windows across midnight; wall-clock so an hour shorter or longer on the night the clocks change). Set on the Beebo Auto phone screen. During the window:

- Voice games **rest**: the folder shows "Quiet hours: games are resting", a game cannot start, and a queue already running stops speaking at the next round.
- Stories still play, **slower** (0.82 speech rate instead of 0.95, longer pauses) and with a **20 minute sleep timer already running** unless one is set.
- The Trip Clock glance still works.
- No notification is posted. (The phone app's 15-minute warning notification is not copied: IN-1 says notifications must be relevant to the driver.)
- The card says "Check your campground's posted quiet hours" and never claims to satisfy anyone's rules.

### The parked-versus-driving rule (`FamilyGate`)

| | Car's own list | This app's screen, parked car (AAOS) | Passenger's phone (not projecting, "I'm a passenger") | Phone running the car screen | Moving car, or car state unknown |
|---|---|---|---|---|---|
| Trip Clock glance, stories: listen | yes | yes | yes | yes | yes |
| Buttons on this app's screen | never | yes | yes | no | no |
| Voice games: listen | only if the parent switched hands-free on | yes | yes | only if hands-free is on | only if hands-free is on |
| Quiet hours | games rest, stories calm, timer on | same | same | same | same |

The buttons rule is exactly `VideoGate.videoAllowed` (a test compares them for every combination), so the phone has one answer to "is it safe to tap". The media service, started cold by Android Auto with no screen open, assumes the strictest case. The setting switches that widen what plays in a car ("Show Family Fun in the car's list", "Allow voice games in the car, hands-free") are themselves disabled while the buttons are.

---

## 3. Safety review

Priority is that nothing in the car needs reading, tapping or looking while driving.

| Risk | What stops it | How it is checked |
|---|---|---|
| A driver taps or reads a game | The car list has titles and one short line only; buttons on the phone screen are disabled unless parked/passenger; the car's Next and Pause are the only controls | `FamilyGateTest`, `FamilyMenuTest` (row length) |
| A game starts by itself | MA-1: nothing plays without a tap or a voice command; the sleep timer only ever pauses | tests: `SleepTimerTest`; code review of `FamilySession.kt` |
| A game encourages a lively driver | Off in the car until a parent switches it on; first line of every game says drivers only listen; quiet hours rest games | `FamilyGateTest` |
| Notifications | None are posted by this feature | `FamilyPrivacyTest` scans for `Notification` |
| Long text, scrolling text, animation | Titles at most 44 characters, subtitles at most 60; no artwork; no motion | `FamilyMenuTest` |
| Microphone, recordings | No `RECORD_AUDIO`, no `SpeechRecognizer`, no `AudioRecord`, no `CarAudioRecord` anywhere | `FamilyPrivacyTest` (manifest and source) |
| Location | No location permission or API in the feature; the Trip Clock state has no coordinate field | `FamilyPrivacyTest`, `TripGlanceTest` |
| Data leaving the phone | The feature makes no network call, uses no account, no server, no analytics, no ads; it is not reported as watch history | `FamilyPrivacyTest` |
| Wrong ETA read as navigation | The estimate line is on every state; the clock uses no map, traffic or route data; "late" never says "you're here" | `TripGlanceTest` |
| Frightening or branded content | Word lists and stories are original, checked against a scary-word list and a brand list | `VoiceGamesTest`, `StoriesTest` |
| Health or sleep claims | Wording is "a timer and a fade, not a sleep aid"; a test looks for claim words in the stories | `StoriesTest` |
| "Kid-safe" wording | Not used; the app stays 18+ and not child-directed | `FamilyPrivacyTest` |

**What is in the phone's cache.** `cacheDir/family-tts/` holds synthetic speech of text that ships in the app, at most 40 files, removed with the app's cache. It is not a recording of anyone. Some speech engines download a voice the first time; that is the engine's own behaviour, not this app's.

**Residual risks, said plainly.**

- A game is still a lively activity in the car. Even with the gate, a driver can be drawn into it by ear. The defaults (off, opt-in, drivers-only-listen line, quiet hours) reduce this; they do not remove it. It is the parents' call and the copy does not call it safe.
- **Media-app policy.** An interactive voice game is not obviously "media". It plays through the media session as spoken-word items, which the guide allows for audiobooks and podcasts [2], but a reviewer could see a game inside a media app. Beebo Auto is sideloaded and not on Google Play; **review this against Google's media and car-app policy before any Play submission.**
- **First-sound delay.** The first part of a story or game is made on the phone when asked, which takes seconds on a slow phone. DR-3 wants content within ten seconds [7]. Not measured.
- **Audio type.** The shared player is set up for movies (`USAGE_MEDIA`, content type movie). Speech content type would let the car duck other audio better; it was left alone to avoid changing existing playback.

---

## 4. Tests

Run: `cd apps/auto && ./gradlew ... testDebugUnitTest` (see the build notes in `apps/auto/README.md`).

| Class | What it covers |
|---|---|
| `FamilyGateTest` | Driving-state gating for every combination of device state; buttons equal the video rule; the car list is never a control surface; hands-free games; quiet hours rest games and calm stories |
| `FamilyQuietHoursTest` | The shared quiet window across midnight, time zones (Toronto, Sydney), spring and autumn clock changes; what quiet hours do to games, stories and the folder |
| `VoiceGamesTest` | Every round of every game for every band and seed; determinism; clue structure; no answer leaks; word-list sizes and uniqueness; letter examples; pauses; brand and frightening-word lists; no digits or symbols; scoreboard |
| `StoriesTest` | Eight stories, bands, lengths, parts cover the text once, script structure, calm pacing, content lists, calm endings |
| `SleepTimerTest` | Fade curve, stop, late ticks, limits, the car button cycle, labels, independence from the wall clock |
| `TripGlanceTest` | Kid units and fuzzy phrases, estimate line in every state, late and arrived, agrees with the phone app's logic, spring clock change, time zone change, no coordinate field |
| `FamilyMenuTest` | Id parsing and rejection, audio addresses, folder shape and row length, queues, gate at start, quiet at playback, speech-file naming, trimming and chunking |
| `WavStitcherTest` | Header, parse, silence, joining, format mismatch, oversize, extra chunks, streamed files, junk input |
| `FamilyPrivacyTest` | Reads the manifest and sources: no microphone, location, network, notification or audio storage; the permission list is unchanged; off by default |

---

## 5. What needs a real head unit, the DHU or a phone (not verified here)

The Desktop Head Unit (DHU) is Google's emulator for Android Auto (SDK Manager, SDK Tools, "Android Auto Desktop Head Unit Emulator"). Start Android Auto's head unit server on the phone (developer settings), run `desktop-head-unit` on the PC, and connect over USB. Check:

1. **The folder appears.** Family Fun as a root tab (only on a host that shows seven tabs) or last inside Movies; how it looks with four tabs. Note rows ("Games are off. See the phone app.") show and do nothing.
2. **Text-to-speech in a projected session.** That `TextToSpeech.synthesizeToFile` works while projecting; that the voice is English on a phone set to another language; how long the first part takes on a slow phone; that it works with the screen off.
3. **Playback.** Stories and rounds play through the car speakers; Next skips a part or a round; Pause works; the gap between parts and between rounds; audio focus with a call or navigation prompt; that a navigation voice prompt ducks or pauses the story and it resumes.
4. **The sleep timer button.** That the custom "Sleep timer" action appears on the now-playing screen on Android Auto (the code uses `setMediaButtonPreferences` with a custom icon; UNVERIFIED on a head unit), cycles, updates its label, fades, and pauses. That the fade is audible on a real speaker.
5. **Truncation.** Long titles ("The Picnic Table at Mile Nine", "The Lighthouse Keeper's Whistle") in the car's list; that nothing scrolls automatically (ST-1).
6. **The gate on Android Automotive OS.** On a real AAOS car or emulator, driving/parked signals change the phone screen's buttons at once. (On Android Auto there is no parked signal at all, so the car-side rules are always the strict case.)
7. **Assistant.** "Next" and "pause" by voice work on the queue. "Play a story on Beebo Auto" is **not** built (see Deferred).
8. **Quiet hours on a real evening** across a real time-zone change.
9. **TalkBack and large text** on the phone screen.
10. **Cold start.** Android Auto starting the service with no screen open: the folder answers with no server signed in, and a signed-out phone still shows Family Fun beside the sign-in row.

---

## 6. Deferred (not built)

- **Import the Trip Clock from the phone app.** The two apps are separate installs; the car keeps its own clock. A hand-off would need a small share action in `apps/core` (the state is one small JSON string with no location) and a check of who sent it. Not done: it needs changes to the phone app and a decision on how the two apps trust each other.
- **Trip Clock in the car from a live route.** No map or route data by design.
- **Voice search** ("play a bedtime story on Beebo"): `onPlayFromSearch` does not know about stories. VC-1 is met by the existing library search; stories are not searchable.
- **Templated media (Car App Library 1.8).** Not adopted.
- **Speech recognition.** Not built, by design. If Google opens a supported path and a lawyer agrees on children's voices, revisit.
- **Real sounds for Name That Sound** (would need original recordings).
- **Other languages.** Words, stories and speech are English only; the voice is forced to English.
- **More content.** Eight stories and the current word lists are a start.
- **Artwork** for rows: none by design in v1.
- **Speech-typed audio attributes** for the shared player.
- **The 15-minute quiet-hours warning notification** from the phone app: dropped on purpose (IN-1).
- **The story "sleep timer" as an Assistant command.**

## 7. Wording rules for anything public

Status labels: **In development**. Say "read aloud by your phone's voice", "no microphone, nothing recorded", "for passengers, never the driver", "estimate only, use your navigation app". Do not say kid-safe, safe while driving, sleep aid, or that it satisfies a campground's rules. Do not describe it as available in a car until it has been tried on a head unit.
