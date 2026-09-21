# Campsite: Scavenger Hunt for Everyone

Status label for public wording: **In development** (built and unit tested on the JVM; not yet run on real
phones or in real mobile browsers; not released). Source of the requirements: the research report
`_research-camping-roadtrip-hiking-kids-2026-09-21.md`, idea 5 and build 6, including its legal and safety notes.

## Why this exists

The older **Scavenger Hunt** (`campsite/ScavengerHuntScreen.kt`) drops GPS waypoints and fans out over the hub
`/room` WebSocket. It is a phone-app-only screen (`PhoneOnly("scavengerhunt")`), so a guest with a plain
browser cannot join it, and it needs internet and a hub sign-in. That old hunt is left exactly as it is (it is
still the GPS mode for app users).

This is a second, separate hunt: an **offline** hunt the host runs on the Campsite hotspot, which guests join
in an ordinary mobile browser. No app, no account, no GPS, no internet. It uses the same campsite server that
already serves the guest games, songbook and quiz.

| | Old Scavenger Hunt | Scavenger Hunt for Everyone |
|---|---|---|
| Who can join | Phones with the app | Any phone with a browser on the Campsite Wi-Fi |
| Needs internet or the hub | Yes | No |
| How things are found | GPS waypoint within about 15 m | Tap a checklist item or a bingo square |
| Location | Waypoint positions (saved only if the host opts in) | **Never used.** No location code exists in the package. |

## What it does

Host (Play > Outdoors > Scavenger Hunt for Everyone, or the card on the Campsite screen):

1. **Pick a hunt card.** Five original sets, each with 26 to 32 items, all written for Beebo:
   **Camp Basics** (28), **Nature Colors** (26), **Night Sky & Sounds** (27), **Rainy Day** (28) and **Hike Bingo**
   (32 squares, drawn as a 3x3, 4x4 or 5x5 bingo card by age).
2. **Pick an age band.** 4-6, 7-10 or 11 and up. An item is offered to its own band and every older one; harder
   items are worth more points (1, 2 or 3). A bingo square is always 1 point and each full row, column or diagonal adds 2.
3. **Pick how many things** (12, 16, 20 or 24; a bingo card uses its whole grid).
4. **Pick how to play.** *Everyone alone* (each guest has their own ticks and their own place on the leaderboard),
   *All together* (one shared list and one score), or *2, 3 or 4 teams* (each team has its own list; a find by any member counts
   once for the team; colours also carry a shape so colour is never the only cue).
5. **Optional timer** (10, 20, 30, 45 or 60 minutes). Off by default.
6. **Optional host approval.** A find counts only after the host taps "Yes, it counts". Finds still waiting when the hunt
   ends do not count. A team may have at most 6 finds waiting so a queue cannot be flooded. Approval is off by default.
7. **Optional photos** (off by default) and, under it, an optional **photo of the day** (off by default). See "Photos".
8. **Open the hunt.** The host phone shows the address and QR code (the usual guest card). Guests open it, type a
   nickname (or skip it) and wait in the lobby, choosing a team if there are teams. **Start the hunt** begins it.

Guest page (`/hunt`, joined like every other campsite page): the list (or bingo grid) with big tap targets, the timer,
their points and place, a live leaderboard (polled about every second), an undo button for their own last finds, and an end screen
with the winner, the reason it ended, their own count and the fixed safety reminders. The winner is whoever has the most
points; on a tie, whoever got there first.

The hunt ends when the host ends it, when the timer runs out (the end time is the timer's, not the moment somebody looked),
or when every player (or team) has found everything.

### Safety and privacy rules it keeps

- Parent-run family feature. No accounts. A guest is a typed nickname held in memory for the life of the hunt.
- **Location is not used at all.** There is no location code in the hunt package (a test scans the sources), and the page is
  served with `Permissions-Policy: geolocation=()`.
- No network calls from the host code, no ads, no analytics, no third-party code, nothing fetched at run time. The guest page loads nothing
  from outside and is served with a strict content-security policy (`default-src 'none'`, scripts and styles inline only,
  `connect-src 'self'`, no frames, no `http:`/`https:` sources).
- **Look, don't touch.** Every item asks only to look or listen. A content-rule test (also run again when the catalog loads,
  so a bad edit cannot reach a child) requires each item to start with *Find, Spot, Look for, Listen for, Hear* or *Notice*
  and rejects words that mean touching, picking, catching, collecting, tasting or taking anything; fire, water, roads, the sun, storms;
  wild food and edibility words; predators and animal homes; other people (nobody is pointed at or photographed); protected names
  and brands; markup characters; and, for a bingo square, anything over 32 characters.
- **Plain safety words** for grown-ups and children are on the host screen and the guest page, before and during every hunt: "Stay with your grown-up, and always
  within sight of an adult." "Look, don't touch: leave plants, animals and their homes where they are." "Never eat or taste anything you
  find." "Stay inside the areas your grown-up says are OK, and on marked paths." plus "Ask a grown-up before you pick anything up." and
  "Check your campground's posted rules." Each card also says where it is played (the night card says "Do not walk off in the dark";
  the rainy-day card says "Stay inside"; the bingo card says "On a marked path with your grown-up").
- **No medical, foraging or survival advice** anywhere, and no claim to be "safe" beyond those plain instructions. Nothing here says
  or implies a child is safe, and a test scans the sources, the page and this document for such claims.
- **Nicknames** are cleaned on the host: control, invisible and markup characters removed, cut to 24 characters, a name that looks
  like contact details (a link, an at-sign, a long number) or that is on a small deny list (or the existing campfire word filter, also when
  written with look-alike digits or spaced out) becomes "Camper" plus a number. Duplicates get a number. The page draws every
  name with `textContent`, never HTML, and the page's own scripts contain no `innerHTML`.
- **Rate limits** per guest: 60 reads and 20 writes per 10 seconds, and at most 10 ticks or un-ticks per 10 seconds, refused with
  "Slow down a little" (HTTP 429) and the page backs off. JSON bodies over 16 KB and the wrong content type are refused by the server before
  the hunt sees them; a hunt holds at most 24 players.
- **Quiet hours** (the `quiet/` package). The host screen makes no sound. The guest page has an optional small chime (off by default) that
  is switched off whenever quiet hours are on: the server puts a `quiet` flag in every view, and the page also honours the quiet banner
  that every campsite page carries. The card set "Night Sky & Sounds" is written as quiet looking and listening ("Whisper when you find something").

### Photos (all optional, all off by default, all stay on the guest's phone)

- With "Photos on their own phones" on, a guest can add a picture to something they found, to show their grown-up. The page uses the phone's
  own camera or gallery picker (`<input type="file" accept="image/*" capture="environment">`) and shows the result with a temporary local
  address (`URL.createObjectURL`). The page **never reads, resizes, stores or sends the picture**: there is no `FormData`, `FileReader`,
  canvas or upload code, the only network call is the small JSON action to `/api/hunt`, and a test checks all of that. Pictures live in the
  page only until it is closed; the guest keeps whatever their own camera app saved.
- **Photo of the day**: one shared prompt (12 written for Beebo, chosen by the calendar day) such as "Photograph something with a pattern."
  Every prompt is about things, not people, and the page says "Photograph things, not people: no faces, no other campers, no signs with names or
  numbers." A guest can tap "I took mine". Only that yes reaches the host, shown as "3 of 5 took theirs". A test checks that no field in any view
  could carry a picture, a file name or a place.
- The host can see nothing but the yes. The photo evidence for an item is for the grown-up standing next to the child.

### What a finished hunt leaves behind

Only on the host phone, and only when at least one thing was found:

1. **One `hunt` moment in the running Trip Journal**, if a trip is running: the card name and a count, for example
   "Scavenger hunt: Camp Basics, best list 14 of 22 items (3 teams)" plus the nicknames of the players. It carries no item words, no photo and no
   coordinate. It is written once per hunt (an id starting `huntcard-` keeps it apart from the old GPS waypoint moments, which read "found by").
   The recap, the present slides and the MP4 export show it under "Scavenger hunt" ("1 hunt played").
2. **Two badge counters** (plain SharedPreferences): items found over finished hunts, and "someone found every item". They feed two new badges,
   **Sharp Eyes** (find 30 things) and **Full Card** (find every item on a card). Existing badge ids are unchanged.

Nothing else is kept: not the list, not who found what, not a photo or location, nothing goes anywhere else.

## Server routes added

| Route | Who | What |
|---|---|---|
| `GET /hunt` | joined phones (else redirect to `/join?next=hunt`) | The guest page. Sent with the family page policy plus `img-src blob: data:` (so a picture from this phone's own memory can be shown). |
| `GET /api/hunt` | joined phones | The current state as JSON (the guest's own list, the leaderboard, the timer, the settings). No token, no other team's ticks. |
| `POST /api/hunt` | joined phones, header `X-Beebo-Hunt: 1`, same origin, JSON up to 16 KB | `join`, `team`, `tick`, `untick`, `potd`. The reply is always the fresh state. |

Starting, approving, ending and closing a hunt are host-phone calls straight into the service; there is no HTTP door for them.

## Files

`apps/core/app/src/main/java/com/beeboentertainment/movie/campsite/hunt/`:
`HuntModels.kt` (bands, settings, the fixed safety words), `HuntCards.kt` (the five card sets, the photo prompts, the content rules and the catalog check),
`HuntScoring.kt` (points, bingo lines, ranking, item selection), `HuntNames.kt` (nickname cleaning), `HuntSession.kt` (one hunt's rules),
`HuntService.kt` (locking, rate limits, guest JSON, host state, the record on finish), `HuntRecords.kt` (the Trip line and the badge counters),
`HuntServices.kt` (the bundle the server takes), `HuntHostScreen.kt` and `HuntEntryCard.kt` (the host phone UI).
Guest page: `apps/core/app/src/main/assets/campsite-hunt.html` (one file, no dependencies).
Tests: `apps/core/app/src/test/java/com/beeboentertainment/movie/campsite/hunt/` (`HuntCardsTest`, `HuntScoringTest`, `HuntNamesTest`,
`HuntSessionTest`, `HuntServiceTest`, `HuntHttpTest`, `HuntTripAndBadgesTest`).

Shared files touched, each in a small additive block: `CampsiteServer` (one constructor parameter, the `/api/hunt` door, `/hunt`, `next=hunt`, and
`img-src blob:` for the hunt page only), `CampsiteWebPages` (one sidebar link), `CampsiteScreen` (one entry card and one callback), `ui/MainActivity`
(one route, one lambda), `ui/screens/PlayMoreScreens` (one menu row), `badges/Badges` (two badges at the end, two counters), and the trip package:
`TripHooks` (`huntCard`, default no-op), `TripLogic` (`recordHuntCard`, `HUNT_CARD_PREFIX`), `TripStore`, `TripSummary` (`huntCards`, and the
waypoint list no longer includes hunt cards), `TripSlides`, and `recap/TripRecap` (one line).

## Test results

108 unit tests cover the hunt (the seven classes above). On 2026-09-21 the full run of `:app:testWebDebugUnitTest`, `:app:testPlayDebugUnitTest`,
`:app:testAmazonDebugUnitTest` and `:app:assembleWebDebug` passed (web 1901 tests, play 1901, amazon 1898, none failed or skipped).
They cover the card counts and age bands, the wording and deny-list rules, scoring, teams, approval, the timer, rate limits, hostile nicknames, the
JSON views (nothing private in them), a real HTTP round trip, the page and source scans (no location, network, camera or microphone code, no unsafe
browser calls, no upload code for photos), the Trip Journal line and the badges.

## How to add or change card items

Edit `HuntCards.kt`, keeping the same shape (`l(...)` little, `m(...)` middle, `o(...)` older). Run the tests: they check the counts, the age bands,
unique ids and wording, the content rules above and, for a bingo card, the 32-character limit. Keep everything original. Do not add plants,
mushrooms or wild food, fire, water, roads, first aid, weather, other people, brand names, or anything that asks a child to touch, pick, catch, collect,
taste or take. Do not use the NPS arrowhead, "Junior Ranger", "Leave No Trace" text or Smokey Bear (protected marks; see the report's section 10).

## What needs real phones

Nothing here has been run on a phone or in a mobile browser: it is checked with unit tests, a real HTTP round trip against the real campsite
server on the JVM, static checks of the page, and one look at the page in a desktop Chromium preview at a 375 px width with the server's JSON
faked (it drew the lobby, a team list, a 4x4 bingo grid and the end screen; that shows the script runs, not how it feels on a phone).

- The guest page in real mobile browsers (Chrome on Android, Safari on iPhone, Samsung Internet): tap targets and text size on small
  screens, the 5x5 bingo grid on a narrow phone (the squares are about 58 px wide on a 360 px screen; text is 13 px and may wrap to four lines),
  the sticky quiet-hours banner over the top bar, the timer bar, reduced-motion behaviour, dark-theme legibility outdoors.
- **Photo capture from the browser**: whether `capture="environment"` opens the camera (or falls back to the picker) on each browser, that the page
  survives the browser being suspended while the camera app is in front (the file input sits outside the redrawn area on purpose), that
  `blob:` pictures show under the page policy, and that the `Permissions-Policy: camera=()` header does not block the picker (it should not:
  that header governs the in-page camera API, which this page never uses).
- How many guests can poll once a second on a real hotspot (the design limit is 24 players), and whether a find shows on a teammate's phone
  and on the leaderboard within about a second.
- Host approval with the host phone in a pocket: how quickly a host notices a waiting find (there is no sound or notification on the host
  phone by design; the queue is on the hunt screen).
- The optional chime on real phones (browsers need a tap before they play sound) and that it stays silent during real quiet hours.
- Accessibility: TalkBack and VoiceOver reading order, large-text settings, and Android TV focus on the host screen (plain buttons, not run on a TV).
- The hunt cards in the field with real children: whether the items are the right difficulty for each band, and whether any item invites a child
  to wander (the wording asks for looking and listening only, but a real family should try each card once).

## Deferred (not built)

- **Clue-code trails** (the parent hides paper or rock clues that carry a short code; typing the code unlocks the next riddle) from the report's
  idea 5b. The data and rules are laid out for it, but this pass builds the card hunts only.
- **Host-written custom cards** (a parent typing their own list). The content rules would need a plain-language editor and a review step first.
- **Hand-off link to Seek or Merlin** (report idea 5e).
- **A "Field Journal" page in the Trip** listing what was found (the Trip line is counts only by design; a richer page needs the consent design in the
  trip-journal plan section 3).
- **Sharing the hunt in the trip's private link export** (the share manifest lists the old GPS waypoints; it does not yet list hunt cards).
- **Approving finds after the hunt has ended, and a grace period for timer expiry** (finds waiting at the end do not count today; the host screen says so).
- **A host-phone sound or notification for a waiting find** (kept silent for quiet hours; a vibration or badge on the Campsite screen could be added).
- Card artwork for the host list and the guest page (visual design is with ChatGPT per the division of labour).
- Translations (English only).
- An Android Compose UI test and a real-browser end-to-end test.
- Website copy: this is **In development** and must not be described as Available until a release contains it.
