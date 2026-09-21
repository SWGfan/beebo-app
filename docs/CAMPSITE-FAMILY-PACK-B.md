# Campsite family pack B: Roadside Quiz and Campfire Songbook

Written 2026-09-21. Status label for public wording: **In development** (built and unit tested on the
JVM; not yet run on real phones). Source of the requirements: `_research-camping-roadtrip-hiking-kids-2026-09-21.md`
builds 2 and 3, with the scope change below.

## Scope change that shaped this pack

The Songbook ships as an ENGINE and a data format, not as a library of songs. No real song text is in
the app, in the tests or in this document. The app carries one tiny built-in demo pack (two short
chants invented for Beebo). Real public-domain song packs are added later, one pack at a time, only
after the legal check in `docs/songs-provenance.md`.

## What is in it

### Roadside Quiz (complete)

- 336 original questions in 8 packs (Animals, Space and Sky, Geography, Nature, Camp Skills, Simple
  Science, Which Is Bigger?, Road-Trip Trivia), 42 per pack, 112 per age band (4-6, 7-10, 11+).
  Every question has four options, exactly one right, a one-line "Did you know?" fact and
  `src`/`lic` = `beebo-original`. Files: `apps/core/app/src/main/assets/quiz/<pack>.json`.
- Host phone screen (`QuizHostScreen`): pick age band (or all ages), packs, 5/10/15 questions, teams
  (none, 2, 3, 4), an optional timer (off by default), and where to play: **guests' phones** or
  **this phone, teams take turns** (no guests, no Wi-Fi: the host taps the answer a team calls out).
  A "Read aloud" button uses the phone's own speech engine (`CampsiteNarrator`), never a microphone.
- Guest page `/quiz` (`assets/campsite-quiz.html`): big answer buttons, team choice in the lobby,
  reveal with the right answer and the fun fact, scoreboard, a countdown only when the host turned one on.
- Scoring: one point per right answer; a team's score is the sum of its members. Answer options are
  shuffled at play time. The right answer and the fact are never sent to a guest before the reveal.
- Finished quizzes write ONE line to the existing Campsite match history (`game = roadsidequiz`,
  not rated, so there is no leaderboard) and count once towards the existing "Trivia Rounds x5" badge.
- Nothing is fetched at runtime. No Open Trivia DB items are included, so no `opentdb-cc-by-sa-4.0.json`
  and no credit screen check are needed today. If OpenTDB items are ever added they must go in a separate
  credited file (CC BY-SA 4.0) and be hand reviewed; the test `onlyOriginalQuestionsShip...` will fail
  on purpose to force that conversation.

### Campfire Songbook (engine complete; content deliberately not shipped)

- Song-pack format (schema 1), validator, importer, provenance template and DENY list (below).
- Host phone screen (`SongbookHostScreen`): song list with search, big-print lyric sheet, Start/Pause,
  Next line, Back, tempo slider (1.5 to 8 seconds per line, or "advance by itself" off for a
  manual next-line-only mode), round mode with 2 to 4 groups and a chosen entry offset, a request
  list from guests, "Songs we sang" with "Add to trip journal" (titles only; guest names only if ticked),
  a campfire theme (dark, and the phone screen dims while the songbook is open), and "Add song pack".
  The host screen works with no guests, no Wi-Fi and no signal.
- Guest page `/songbook` (`assets/campsite-songbook.html`): lyrics at least 28 px, growing with the
  screen width, a bigger "current line", the previous and next lines dimmed, chorus cue ("Everybody"),
  A-/A+ size buttons, a campfire (dark, dim) theme by default with a brighter choice, round groups with
  a shape and a name (never colour alone), "get ready" and "your turn" banners, a song list where a
  guest taps a heart to ask for a song (at most 5 open requests each; no free text anywhere).
- Sync: the host owns one number, the step. In auto mode a guest computes the step from the host's
  last reply plus its own clock, so lines move smoothly between polls; a manual Next line reaches every
  phone within one poll (about 0.8 seconds). Polling only; the songbook does not use the WebSocket.

## The song-pack format

```
{ "schema": 1, "packId": "kebab-case", "title": "...", "demo": false,
  "legalCheck": { "by": "who checked it", "date": "YYYY-MM-DD", "note": "..." },
  "songs": [ {
     "id": "kebab-case", "title": "...",
     "origin": "who, when, where (or 'Original to Beebo, ...')",
     "pdBasis": "why we may show this text, in a sentence",
     "sourceUrl": "https://... (required unless the origin starts with 'Original')",
     "year": 1900,                      (optional; after 1928 needs an 'Original' origin)
     "kind": "round" | "singalong" | "lullaby" | "story",
     "lineSeconds": 3.0,                (optional, 1.5 to 8)
     "round": { "groups": 3, "repeats": 3, "offsetLines": 2 },   (optional; groups 2-4, repeats 2-4)
     "lines": [ "plain text", { "text": "...", "refrain": true, "gap": true, "entry": true } ] } ] }
```

- `entry: true` on a line is the round-entry marker: the next group comes in on the line after it.
  Without a `round` block a marker gives groups 3 and repeats 3.
- Lines are words only: no chords, markup characters (`< > & [ ] { }`), "repeat" or "x2" markers,
  control or invisible formatting characters; 1 to 60 characters; 2 to 80 lines a song; at most 200
  songs a pack; the file must be under 1 MB.
- All-or-nothing: one bad song rejects the whole file and every problem is listed. An imported pack
  must carry `legalCheck.by` and `legalCheck.date`. A title on the DENY list is refused in any case or
  punctuation. A song that clashes (id or title) with one already loaded is refused; a pack with the
  same `packId` as an imported one replaces it.
- Import path: Songbook screen, "Add song pack", system file picker. The file is read locally, checked,
  and kept in the app's private folder `files/songbook-packs/<packId>.json`. It is never uploaded.
  "Remove" deletes an imported pack; the built-in demo pack cannot be removed. A stored pack that fails
  the checks at start-up is skipped, not trusted.
- Validator code: `songbook/SongbookModels.kt` (`SongbookRules`, `SongbookDenyList`),
  `songbook/SongbookPackParser.kt`, `songbook/SongbookLibrary.kt`.

## Privacy and safety facts (all checked by tests)

- No accounts, no ads, no analytics, no third-party code. Both packages contain no network, microphone,
  camera or location API (a test scans the sources); both pages load nothing from outside and are served
  with `Content-Security-Policy: default-src 'none'; connect-src 'self'; ...` and
  `Permissions-Policy: microphone=(), camera=(), geolocation=()`.
- Guests are a typed nickname only. The name is stripped of control and markup characters and cut to
  24 characters on the host, and pages only ever use `textContent`, never HTML.
- Limits: JSON bodies over 16 KB and wrong content types are refused; each guest may make 20 writes and
  40 (songbook) or 60 (quiz) reads per 10 seconds, after which they get 429 and back off; at most 40
  songbook guests and 24 quiz players; a stale question number cannot land on a new question.
- The quiz says "passengers only, never the driver". No medical, wild-food or safety-critical advice is
  in the questions; a rule set (banned words and phrases, including protected names) runs in the unit test
  and again at load time, so a bad edit cannot put a bad question in front of a child.
- Nothing about children is collected. The Trip entry for sung songs is titles only, saved on the host
  phone, once per session (updated in place), and names only when the host ticks the box.

## Files (new)

`apps/core/app/src/main/java/com/beeboentertainment/movie/campsite/`:
`family/` (FamilyCommon, FamilyHostUi, FamilyPackBHost), `quiz/` (QuizModels, QuizEngine, QuizService,
QuizHostScreen), `songbook/` (SongbookModels, SongbookPackParser, SongbookLibrary, SongbookEngine,
SongbookService, SongbookHostScreen). Assets: `assets/quiz/*.json`, `assets/songbook/demo-pack.json`,
`assets/campsite-quiz.html`, `assets/campsite-songbook.html`. Docs: this file and `docs/songs-provenance.md`.
Tests: `src/test/.../campsite/quiz`, `.../songbook`, `.../family`.

## Shared files touched (each in a small, separate block, for an easy merge with the other agent)

- `CampsiteServer.kt`: one constructor parameter (`family`), the two JSON doors (`/api/songbook`,
  `/api/quiz`) before the GET-only gate, `next=songbook|quiz` in `/join`, two GET pages, and
  `writeFamilyHtml` (the page policy headers).
- `CampsiteWebPages.kt`: two entries appended to the desktop sidebar links.
- `CampsiteScreen.kt`: two new default parameters and one `FamilyPackBEntryCards(...)` call.
- `ui/MainActivity.kt`: two routes (`songbook`, `roadsidequiz`) and two lambdas into `CampsiteScreen`.
- `ui/screens/PlayMoreScreens.kt`: two menu entries under Outdoors.
- `trip/Trip.kt`, `TripLogic.kt`, `TripStore.kt`: `MomentKind.SONG` and `recordSongs` (additive).
  The recap screen does not draw `song` moments yet (deferred).

## How to add quiz questions

Edit or add to a pack file, keeping the same shape. Run the tests: they check four distinct options,
one right answer, duplicate prompts and facts, reading level, banned words and advice, and that answers
are spread over all four positions. Keep every question original; a fact must be something you can
source. Do not add plant, mushroom or wild-food questions, first aid, weather or fire safety, or brand names.

## Legal review checklist for a lawyer

Not legal advice; these are the questions to put to a lawyer before this is released to families.

1. Quiz: are the 336 original questions and facts acceptable as Beebo's own work (they state common
   knowledge; a few facts, such as record heights and dates, are ordinary reference facts)? Is a
   "source" line per fact wanted beyond `beebo-original`?
2. Songbook: does the wording in `docs/songs-provenance.md` (checklist, DENY list, `legalCheck` record) make a
   pack a sufficient statement of basis? Who signs? Is a per-country statement needed (US cutoff moved to
   works published before 1931 on 2026-01-01; the app uses a stricter 1928 guard)?
3. The DENY list: review its reasons and add any title the lawyer knows is protected.
4. Children's data: confirm that a typed nickname, held in memory for a session, plus one local
   match-history line, is not collected personal data of children under the amended COPPA rule, and
   confirm the audience position (18+ app, features run by a parent) before any family marketing.
5. Marketing wording: the status is In development; never write "kid-safe", "COPPA compliant" or
   "no data" as blanket claims.
6. "Roadside", "Songbook", "Quiz" and the demo chant titles: any name clearance wanted?

## What needs real phones

- Sync feel on a real hotspot: how many guests can poll every 0.8 s, and whether a manual Next line reaches
  everyone within one second (the design targets it; the JVM tests cannot measure Wi-Fi).
- The guest pages in real mobile browsers (Safari, Chrome, Samsung Internet): text sizing, notch and
  gesture bar padding, dark and dim theme legibility outdoors, long titles, one-hand use.
- The host screen dimming (`screenBrightness = 0.15`) and keep-awake on several phones; TalkBack reading
  order; Android TV D-pad focus on the two screens (they are plain buttons but were not run on a TV).
- "Read aloud" voice quality on cheap phones; the file picker for "Add song pack" on Android 7 to 15,
  including a provider that gives a slow or huge file.
- Battery and heat with the screen on for an evening.

## Complete versus deferred

Complete: quiz content and engine, quiz host and guest UI, teams, timer, turns mode, history line and
badge hook, songbook engine, host and guest UI, round mode, request queue, campfire theme, song-pack
schema, validator, importer with file storage, DENY list, provenance template, the trip entry, server routes
and page policy, tests (content, engine, service, HTTP, XSS, limits, rate limits, pack rules).

Deferred: real public-domain song packs (need the legal check), a credits screen listing an imported
pack's origins to guests, recap display of `song` moments, melody or pitch pipe (no audio by design),
sharing the WebSocket with the music hub, per-guest silent-disco style headphones, a "Songs we sang"
list on the guest page, translations, and Trip Clock and Quiet Hours integration (the other agent's
work: the quiz and songbook do not yet respect Quiet Hours, and the Read-aloud button should be silenced
by it once it exists). Also deferred: a browser-based check of the two pages (only static checks and
HTTP tests run here) and an Android Compose UI test.
