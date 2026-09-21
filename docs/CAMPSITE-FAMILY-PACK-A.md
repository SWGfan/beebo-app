# Campsite Family Pack A

Status: **In development** (code on a worktree branch, unit-tested, not yet run on real phones, not released).
Source of the requirements: the research report `_research-camping-roadtrip-hiking-kids-2026-09-21.md`
(section 6 ideas 1, 2 and 8; section 8 builds 1, 4 and 5, with their acceptance criteria).

Three parent-run features for the Android app (`apps/core`, package `com.beeboentertainment.movie.campsite`):

| Feature | Where | What a guest sees |
|---|---|---|
| License Plate and Sign Hunt | Games list (Outdoors & travel), also solo on the host phone | A checklist game in the guest browser |
| Trip Clock ("are we there yet?") | Play > Outdoors > Are We There Yet?, and a card on the Campsite screen | A read-only page at `/clock` |
| Quiet Hours and Bedtime Wind-Down | Campsite screen and Play > Outdoors > Quiet Hours & Wind-Down | A banner on every guest page |

## Rules every part keeps

These come from the research report (section 10) and the project rules.

- Family features that a parent runs. Guests are anonymous typed nicknames; there are no accounts.
- Nothing is collected from children. No analytics, no ads, no third-party code, no network calls.
- Location stays on the device and is **off by default**. Only the Trip Clock can use it (optional, coarse, in memory, never saved).
- No claims of "kid-safe", no emergency, rescue or navigation claims, no medical or sleep claims, no claim to satisfy a campground's rules.
- Everything works with no internet.
- All guest text is escaped: the pages draw it with `textContent`, never `innerHTML`. Unit tests grep the page scripts for the unsafe browser calls.
- The Amazon build stays free of Google Play services: only the framework `LocationManager`, `TextToSpeech`, `AudioTrack` and `NotificationManager` are used.

## 1. License Plate and Sign Hunt

Wire id `plates`, category Outdoors & travel, `needsGuests = false`, playable alone.

- Lists: **USA** (50 states + DC = 51), **Canada** (10 provinces + 3 territories = 13), **Both** (64), **Alphabet A-Z** (26, found in order).
  Wording is "jurisdictions" because DC is not a state. Only names and postal abbreviations are used: no plate images, seals, slogans or brand names (a test holds every string, the region names and the page script against a deny list of state slogans, seals and brands).
- **Team mode**: any player's tap ticks the item for everyone and the list shows who spotted it. A second tap on an item already found is not an error and does not steal it.
- **Race mode**: everyone has their own list; the first to complete it wins. A player's list is only ever in that player's own snapshot (`view(viewerId)`); other players and spectators get a count. A test checks another player's list never appears.
- **Un-ticking**: a player can take back their own tick; the leader can take back any (in a race the leader names the player, blind, since the list is private). On the page taking back is two taps on purpose. In the alphabet only the latest letter can be taken back so the list never has a hole.
- **Rate limit**: 12 taps per 3 seconds per player (`PlateHuntGame.RATE_MAX`, `RATE_WINDOW_MS`), refused with "Slow down a little".
- **Solo on the host phone**: `playsSolo = true` and `seats.min = 1`. The host's Games list says "Play on this phone", opens it through `CampsiteLocalGames` (no guest server, no hotspot), and seats no computer player.
- **Text on screen**: "Passengers only, never the driver" is in the blurb, the round prompt, the lobby and the how-to-play card.
- **Trip Journal**: a finished round writes one `tally` moment ("Spotted 34 of 64 jurisdictions", counts and nicknames only) to the running trip through `TripMomentSink.tally`. With no trip running nothing is written. A round where nothing was spotted writes nothing (a deliberate small departure from "a finished round writes one": an empty line in a recap helps nobody). No location is read; a `TallyResult` has no coordinate field.
- **Badges**: two added at the end of `BADGES` (existing ids unchanged): `plate_spotter_20` (20 plates spotted over finished rounds, alphabet rounds do not count) and `alphabet_complete` (a finished A-Z round with every letter). Two small counters in the plain SharedPreferences; nothing else is kept.

Files: `platehunt/PlateRegions.kt`, `PlateHuntGame.kt`, `PlateHuntRecords.kt`; page script `assets/campsite-platehunt.js`.

### How the page gets the game (and how the next game can)

`campsite-games.html` is one large closure. It now has a small extension table `PACK_A = {lobby:{}, draw:{}}`, three hooks (lobby, round, and "no generic Play again") and a marker `/*@PAGE_PACKS@*/` before it starts polling. `CampsitePagePacks` pastes each script in `CampsitePagePacks.SCRIPTS` at the marker, for both the guest server and the host phone's own copy. A script registers `PACK_A.lobby[gameId]` and `PACK_A.draw[gameId]`. To add another pack: add the file to `assets/`, add its name to `SCRIPTS`. A pack script must not contain `</script>` and must not use `innerHTML` (tested for the plate script).

## 2. Trip Clock

A back-seat progress screen. It is an **estimate**: "Estimate only. Use your navigation app for directions." is on every screen. It is for passengers, not a navigation or safety product, and it uses no maps or traffic data.

- **Setup**: trip length (hours and minutes) or an "arrive at" time, an optional route distance, kid units (TV episodes at 22 min, songs at 3.5 min, or plain time) and an activity nudge (never, every 30 minutes, every hour).
- **Running**: time left in words and kid units ("about 3 episodes"), a road with a car, the parent's stops as pins, a one-tap **+15 min** (from now if already late), stop chips (Snack, Fuel, Stretch, or a typed name), "We've arrived", "Stop the clock". Buttons and chips are at least 48 dp (a test checks the screen).
- **Nudges**: at each 30 or 60 minute mark a card offers "Pick a game" (opens the Games list) or "Not now". It stops once late or arrived.
- **Time zones and daylight saving**: every duration is the difference of two epoch-millisecond instants. A wall-clock time ("4:30 pm") is used once, when typed, to pick an instant. Tests with a fake clock cover the spring and autumn clock changes (Toronto), a phone crossing three time zones (the countdown does not change, only how the arrival reads), and arrival times that have already passed today.
- **Survives restart and reboot**: the state is one JSON string in the plain SharedPreferences, all epoch-based. A test re-opens a fresh store on the same storage.
- **GPS is off by default and every time the screen opens.** If switched on it asks for coarse location only (`ACCESS_COARSE_LOCATION`, network provider), only while the screen is in front (registered on start, removed on stop and on leaving), and adds up movement in memory (`PathProgress`) against the typed distance. It is rough and labelled "not exact". Nothing is saved: `TripClockState` has no coordinate field (a test checks the fields and the saved JSON). A stop added while GPS is on hands its position to the trip, which drops it unless the trip's existing "Save hunt locations" switch is on.
- **Trip Journal**: starting the clock starts a Trip (with its `departed` moment) or attaches to the running one, so there is never a second trip. Stops become `stop` moments and arrival an `arrived` moment (which does not end the trip: the family is at camp; "We're home" still ends it). The recap and the present/video slides get an "On the road" section only when there is something in it.
- **Guests**: `/clock` (needs the normal campsite join) draws a read-only road and the time left from `/api/family`, polled every 3 seconds. No controls.

Files: `tripclock/TripClockLogic.kt`, `TripClockStore.kt`, `TripClockController.kt`, `PathProgress.kt`, `TripClockScreen.kt`, `TripClockGuestPage.kt`.

Not done: see "Deferred".

## 3. Quiet Hours and Bedtime Wind-Down

**Quiet hours** (default **off**):

- Host sets the window with presets: start 9, 10 or 11 pm; end 6 or 7 am. Windows that cross midnight work. The window is wall-clock ("10 pm to 6 am"), so on the night the clocks change it is an hour shorter or longer in real time, as the sign on a campground gate would be. Tests cover several time zones (Toronto, Los Angeles, Kolkata, Sydney, UTC), both clock changes, a Sydney spring change, and an edge falling in the missing hour.
- A one-time evening prompt asks whether to turn it on when a Campsite session starts between 8 pm and 5 am and quiet hours were never answered. "Not now" never asks again on its own.
- During the window: the host phone's narrator (`CampsiteNarrator`) is silent; the Hot Potato alarm tone is silent (vibration and the screen flash remain); the guest browsers stop their own speech; and "play together" music is **refused** until the host taps **Play with headphones**, confirming everyone has headphones in. That confirmation applies to that quiet period only. (Browsers cannot detect headphones, so this is the host's word, not a check. Per-guest silent-disco sync is a later step, as in the report.)
- **Guest banner**: every guest page gets a banner ("Quiet hours until 6:00 AM. Please keep the sound down." or "... Headphones only, please.") within one poll cycle. The server adds it to every HTML page it sends (`FamilyBanner.inject`), so no page needed an edit and later pages get it free. It polls `/api/family` about every 4 seconds (5 seconds is the limit), only while the page is visible.
- **15-minute warning**: while Campsite is running a monitor (`QuietMonitor`, every 30 seconds) posts a "Quiet hours start in 15 minutes" notification once per window, and guests see a "start winding down" line. If notifications are off on the phone the notification is skipped and the Campsite screen still says it.
- **Nights kept**: a night counts when quiet hours were on and Campsite ran during the window. It shows in the trip recap as "Quiet hours kept: 3 nights" and earns a **Quiet Hero** badge at 3 nights.
- **Copy**: "Check your campground's posted quiet hours." appears on the card, the music card, the refusal message and the guest status. Nothing claims to satisfy a campground's rules, and nothing makes a health claim (a test scans the sources).

**Wind-Down** (one tap, 10, 20 or 30 minutes):

1. A gentle story read by the phone's own voice (three short original stories written for Beebo, bundled in the app; can be switched off).
2. Then ambience made on the phone (`AmbienceSynth`: rain, crickets, waves or fire), kept below full volume.
3. Then a fade over the last minute (a fifth of a short session), then stop.
4. **Nothing plays after the timer ends**: the sequence is a state machine (`WindDownRunner`) tested with a fake clock and a recording fake. Late ticks and a late "story finished" do nothing. A story cut off at 40% of the time so the ambience always comes. A visible **Cancel** is shown throughout and stops everything at once.
5. Wind-Down deliberately bypasses the quiet-hours narrator gate: it is the host choosing gentle sound at bedtime.
6. The screen says: a story and some quiet sound, not a sleep aid and not a treatment for anything.

No new network calls; all local. The existing 15-minute idle self-stop of Campsite still works (the monitor is stopped with the server).

Files: `quiet/QuietHours.kt`, `QuietHoursStore.kt`, `QuietRuntime.kt`, `QuietMonitor.kt`, `WindDown.kt`, `WindDownController.kt`, `QuietHoursCard.kt`.

## Server routes added

Only one, plus a page:

| Route | Who | What |
|---|---|---|
| `GET /api/family` | anyone for `quiet`, joined phones for `clock` | `{"ok":true,"quiet":{...},"clock":{...}}`. GET only, `Cache-Control: no-store`. Carries words and numbers the host decided; no guest text, no location. |
| `GET /clock` | joined phones (else redirect to `/join?next=clock`) | The read-only trip clock page. |

## Shared files touched (kept small, for merging with the other agent's pack)

`CampsiteGameCatalog` (one entry), `CampsiteGame` (`playsSolo`), `CampsiteGames` (a `plates` sink and a `keepPlates` call in `settle`), `CampsiteLocalGames` (no computer for a solo game), `CampsiteServer` (`family` property, `/api/family`, `/clock`, banner in `writeHtml`, join `next=clock`), `CampsiteWebPages` (one nav link), `CampsiteScreen` (buttons and cards), `CampsiteHost` (page packs, monitor start/stop), `GuestGamesScreen`, `CampsiteEntryFlow.labelFor`, `campsite-games.html` (extension table, three hooks, marker), `MainActivity` (two routes), `PlayMoreScreens` (two menu rows), `TvSupport` (Trip Clock is phone-only), `TripMomentSink` (`tally`, default no-op), `Trip.kt`/`TripLogic`/`TripStore`/`TripSummary`/`TripSlides`/`TripData`/`TripRecap` (new moment kinds and the "On the road" section), `Badges.kt` (three badges, all new ids), `AmbiencePlayer` (`setVolume`), `CampsiteNarrator`/`CampfireAlarm`/`CampsiteMusicHost`/`CampsiteMusicCard` (quiet gate).

## Tests

`campsite/platehunt/PlateHuntTest`, `campsite/quiet/QuietHoursTest`, `WindDownTest`, `campsite/tripclock/TripClockTest`, `campsite/family/FamilyPackTest` (includes a real HTTP server round trip), `trip/TripFamilyPackTest`. They cover the counts and uniqueness of every list, catalog uniqueness, team and race rules, the private race list, un-ticking, ordered alphabet, rate limits, hostile nicknames, solo play with no server, the trip tally with and without a trip, badges, the deny list, the page scripts, quiet windows across midnight and time zones and daylight saving, the once-only warning, the wind-down timeline and cancel, the trip clock across clock changes and zones, restart survival, no location anywhere in what is saved, and the banner and status over HTTP.

## What needs real phones (not verified here)

- The guest pages in real mobile browsers (Chrome on Android, Safari on iPhone): the plate grid on small screens, taps on a bumpy road, the banner position under the library page's own sticky bar, the road scene at narrow widths, reduced-motion behaviour.
- Bedtime Wind-Down on a real phone: how long the phone's voice takes to read a story, how it sounds at the 0.82 speech rate and 0.7 volume, whether the story and ambience keep going with the screen off and the app in the background (Android may stop them; a foreground service for a running wind-down may be needed), the ambience level on a phone speaker, and the fade.
- Quiet hours on a real hotspot: the banner appearing on every guest phone within the promised poll cycle, and the notification permission prompt behaviour on Android 13+.
- Trip Clock GPS: how coarse network location behaves in a moving car, whether the accumulated distance is a useful progress, battery use, and that updates really stop with the screen off. The permission prompt path.
- The music refusal in quiet hours against the real synced-music hub (which itself is "not yet measured on real phones", see `CAMPSITE-SYNCED-AUDIO.md`).
- Time zones on a real phone crossing a border while the clock runs.
- TalkBack and large-text on the new screens.

## Deferred (not built)

- Beebo Auto: the Trip Clock passenger view in the Android Auto app and its drive-gate check. `apps/auto` is a separate app; the Trip Clock here is a phone screen and a guest page only. **Now started in a separate branch: see `docs/BEEBO-AUTO-FAMILY.md`** (a read-only glance in the car's media list, built on this pack's `TripClockLogic` and quiet-hours code synced into the car app, with `VideoGate` deciding parked versus driving). The car app keeps its own clock; importing the phone app's clock is not done.
- Kid units from the owner's own library ("about 2 of your episodes"); only generic constants are used.
- Deep link from a nudge straight into Plate Hunt, a quiz or a songbook (it opens the Games list; the quiz pack and songbook belong to the other agent's work).
- "Count the..." rounds (bridges, horses, red cars) from the report's idea text; only the acceptance-criteria lists are built.
- Per-guest synced "silent disco" for quiet hours (waits on real-phone sync measurements), and a headphones check (impossible in a browser).
- A foreground service for a running Wind-Down, if real phones show the background behaviour needs it.
- Card artwork for the plate game in the Games list (the list shows an empty art box; the page has no cover art). Visual design is with ChatGPT per the division of labour.
- A "Trail passport" style badge screen for the three new badges beyond the existing Badges list.
- Website copy: the report's proposed chips (Planned, then In development once merged) are not changed here. Do not describe these as Available until a release contains them.
