# Movie Night

Shared-screen party games for the living-room TV, played from phones, made from **your own library**. The TV
shows a big QR code and a short room code; up to 12 guests join from a phone browser on the home Wi-Fi (no
account, no app, no internet); the games are built from the posters, taglines, cast and years your computer has
already saved. Plex has nothing like it.

Status: **Beta / needs real-device testing** (see "What needs real TVs and phones"). Nothing here needs the
internet once the library's TMDB data has been saved once.

## Relation to Campsite Mode

Campsite Mode (apps/core) runs party games from a host phone or Android TV on a hotspot, with no server. Movie Night
takes the same ideas to the **home network**, hosted by the Beebo desktop server that already has the library: the
"Movie Trivia" quiz (questions from the host's own cached library, answers never leave the host until the reveal) and
"Pick the Next One" (an unranked group pick decided with the host's random source) became Cast Match / Name That Movie /
Trivia Night and the fair vote here; the guest-page-by-QR joining, room code + join key, guest nicknames and host
controls follow the Campsite and car-party (`partyRoom.js`) designs. No Kotlin was ported: the rules are re-written as
pure JavaScript with tests. The Campsite games that are not about films (bingo, spy, draw and guess, board games)
are not part of Movie Night.

## Using it

* **From the desktop app.** Open a film's page and press **Start Movie Night**, then choose *Show it on this
  computer* (a window opens; plug the PC into the TV or cast the window) or *Show it on my TV or another screen*
  (the room waits 15 minutes for the next TV that opens `http://<this computer>:47811/tv`). Starting it from a film's
  page makes the night about that film: a group vote can already include it, **Play tonight's movie** starts it,
  and the **Intermission quiz** asks about it first.
* **From any TV browser.** Open `http://<computer's LAN address>:47811/tv` (or `/movie-night`). It starts a room
  by itself. Signed-in browsers use their own profile; otherwise the owner's rating limit applies (see Settings).
* **From the Samsung / LG / Xbox app.** Home has a **Movie Night** rail with one tile. Selecting it starts a room
  as the signed-in person and opens the server's TV page.
* **Guests.** Scan the QR code (or open the join page and type the room code), pick a nickname and a colour,
  play. The first guest to join is the *host guest* and can start games, skip, pause, remove people and end the
  night from their phone; the TV's remote can do all the same things.

### What is on the TV

Lobby (QR, code, players, game menu, teams / rounds / lock / QR-only / sound), the question (with the poster,
clues, options and a countdown), the reveal (answer, who got it, points, top five), the vote and its result, the
final scoreboard (players and teams) and a Back-key dialog. Text is large (about 25 px on a 1080p TV), high
contrast, colours are never the only signal, everything is reachable with the arrow keys and OK, and it honours
reduced-motion and high-contrast settings.

## The games

| Game | What happens | Points |
|---|---|---|
| **Name That Movie** | A poster that starts as chunky pixels gets clearer in four stages (0 / 35 / 60 / 80 % of the time). Stage 1 adds the tagline, stage 2 the top cast, stage 3 the year. Pick the title from four. | 1000 / 700 / 400 / 200 by the stage you answered in |
| **Cast Match** | "Which of these actors was in *X*?" One billed actor, three who are not in that film's saved cast list. | 600 + up to 400 for speed |
| **Year Guess** | A year slider. | 600 for the exact year, minus 40 for every year off (never below 0), and the closest guess gets +400 (a tie shares it) |
| **Before or After** | Two posters: which came out first? Different years, at least two apart when possible. | 600 + up to 400 for speed |
| **Trivia Night** | A mixed round of all of the above plus tagline ("which film had this tagline?") and "who played *character* in *X*?". | as above |
| **Intermission quiz** | Three quick 15-second questions, about the film that just played first. | as above |
| **Pick Tonight's Movie** | A fair group vote, then **Play it**. | none |

Speed points are `400 x time left / time allowed`. The first answer stands. Team score is the members' **average**
so a team with one more person is not favoured; new players join the smallest team; *Shuffle teams* deals fairly.
Ties share a rank (1, 1, 3). Times: 30 s / 20 s / 25 s / 15 s / 20 s / 20 s, 6 s reveal, vote 60 s.

### The vote

Each guest taps **Yes** on every film they would be happy with and may **Veto** one, then **Send my vote**. A film
vetoed by a majority is out (unless that would leave nothing). Score = approvals - vetoes. A tie is broken by
fewer vetoes; a tie that remains is settled by a **fair random draw** with the operating system's secure random
generator (not "whoever voted first"). The screen says which rule decided it. The vote closes when everyone
connected has pressed Send, after 60 s, or when the host closes it. Guests can only change their own ballot;
nobody sees anyone else's. With *Let guests suggest films* on, guests can search the room's own (already filtered)
titles and add up to two to the ballot (8 films at most).

**Play it** sends the TV to the film's player page with the room's read-only reaction ticket in the address
fragment (see "Reactions").

## Where the questions come from

`electron/movieNightLibrary.js` reads only what is already on disk: the TMDB manifest (title, year, poster path,
rating, tagline), the cast file, the poster and actor-photo folders and the details-page cache (`details/movies.json`,
which holds taglines and ratings for films whose page was opened while online). It never touches the network.
Films with too little saved (no year, no cast, no tagline) simply do not appear in the games that need them; the
lobby says what a game still needs ("at least 4 films with a poster, tagline or cast saved"). Cast Match's wrong
answers are actors who are not in that film's *saved* cast list (the top billed, up to 15), so a rare wrong answer
could in truth have a small part in the film; the question says "was in", not "was billed in".

Posters shown are the ones already cached for the library (`/media/poster/<tmdbId>.jpg`, public like the rest of the
artwork). The TMDB attribution ("This product uses the TMDB API but is not endorsed or certified by TMDB.") is
shown on the TV screen and the phone page. No other artwork, music, fonts or sounds are used; sound effects are made
on the spot with WebAudio and are off until someone presses **Sound** on the TV (or the owner turns them on by default).

## Parental controls and privacy

* A room has one **host profile**: the signed-in person on the TV, the owner for the desktop button, or nobody
  (an anonymous TV). Only titles that profile may see (`contentGate.allowId`) **and** that are inside the owner's
  **rating limit** are ever put in a game. The limit defaults to **PG-13**; with a limit set, a film with no rating
  saved is left out unless the owner ticks *Include films with no rating saved*.
* Guests have no account and give only a nickname. Nothing is stored: rooms live in memory and end with the night,
  no accounts, no analytics, no ads, no cookies, no third-party requests. The phone remembers your nickname (and its
  own room ticket for the length of the browser tab) in the phone's own storage only.
* Addresses are used only to rate-limit and to keep a removed guest out; inside the room they are a salted hash.
* Nicknames: 16 characters, control / bidi / zero-width characters removed, no web addresses or e-mail, unique.
  Names are shown with `textContent` only. The host can remove anyone; a removed guest cannot return under the same
  name from the same phone. **Lock room** stops new joins. There is no word filter; supervise the room as you would
  any group activity.
* Movie Night is a family activity, not a children's product: there is no child profile, no messaging between guests
  and no free text apart from the nickname.

## Settings (desktop > Settings > Movie Night)

Allow Movie Night; most guests (1-12); film rating limit (none / G / PG / PG-13 / R); include unrated films; which
games are on; let guests suggest films; first guest may run the games from their phone; only on my home network
(default on); a TV or browser may start a room without signing in (default on); sound effects on by default.
Stored under the `movieNight` setting; the IPC (`electron/movieNightIpc.js`) validates every value.

## URL contract (for TV apps and other clients)

All paths are on the server's own origin. No third-party hosts.

| | |
|-|-|
| `GET /tv`, `/movie-night`, `/movie-night/tv` | The shared-screen page. It reads the room ticket from the address fragment `#k=<ticket>` (kept in `sessionStorage`, removed from the address bar); with none it starts or claims a room itself. |
| `GET /movie-night/join?c=<code>&k=<key>` | The phone page (what the QR opens). `c` is the 6-character room code, `k` the 16-character join key; the page removes `k` from the address bar. `c` alone works unless the host chose **QR only**. |
| `POST /api/movie-night/tv/create` (Bearer) | For TV apps: starts a room as the signed-in person. Reply `{ ok, code, ticket, tvPath: "/movie-night/tv", hash: "k=<ticket>" }`. Open `origin + tvPath + "#" + hash`. Refuse any reply whose `tvPath` is not exactly that or whose ticket is not 32 URL-safe characters (`apps/smarttv/app/js/util/movienight.js` does). |
| `GET /api/movie-night/status` (Bearer) | `{ ok, enabled, available, reason, message }`. |
| `POST /movie-night-api/tv/create` | The TV page's own call (cookie or nothing). |
| `POST /movie-night-api/join` `{ code, key?, name, colorId? }` | -> `{ ticket, guestId, name, host }`. |
| `POST /movie-night-api/act` `{ ticket, type, ... }` | Every action. Guests: `answer {value}`, `vote {approve[], veto, done}`, `react {emoji}`, `suggest {key}`, `rename`, `color`, `leave`, `ping`. Host (TV or host guest): `start {game, rounds?}`, `skip`/`next`, `pause`, `resume`, `endGame`, `lobby`, `kick {target}`, `makeHost {target}`, `lock {value}`, `qrOnly {value}`, `teams {teams: 0/2/3/4}`, `shuffleTeams`, `rounds {rounds}`, `launch`, `close`. |
| `GET /movie-night-api/events?ticket=` | Server-Sent Events: `state` (the whole room for that screen), `reaction`, `launch {href, title, n}`, `kicked`, `closed`. `retry: 2000`, a heartbeat comment every 15 s. |
| `GET /movie-night-api/poll?ticket=&since=` | The same state as one request (used automatically if streams are blocked; about a second of latency). |
| `GET /movie-night-api/preview?c=&k=`, `/search?ticket=&q=`, `/tv/info?ticket=` | Join-page check, film search (guests, when allowed), the TV's QR and join address. |

Tickets are 192-bit random tokens. **TV** ticket: everything. **Guest** ticket: play. **Overlay** ticket
(`overlayTicket` in the TV's state): read-only.

### Reactions over a film

The emoji bar is on the phone at all times. Reactions are sent to the TV page and to any **overlay**: a player page
that opens with `#mn=<overlay ticket>` in its address. `/watch` and `/tvwatch` carry the overlay script (one line in
`streamServer.playerPage`); it does **nothing** unless that fragment (or the same tab's `sessionStorage`) holds a
ticket, so a normal player page makes no request. It shows at most six small emoji with the sender's first name,
bottom-right, ignores pointer input, honours reduced motion, and moves into the full-screen element when that is not
the `<video>` itself. A native player (Android TV, Roku, Apple) can open
`GET /movie-night-api/events?ticket=<overlayTicket>` and draw the `reaction` events itself
(`{ emoji, name, color, glyph, at }`).

## Security

* Rooms: 6-character code (31-character alphabet) + 96-bit join key + separate 192-bit tickets. Wrong code / key look
  identical (`not_found`); 10 wrong tries per address in 15 minutes locks that address out. Codes, keys and tickets do
  not reach the logs: the server logs request paths, not query strings, its log redaction masks `code=`, `key=` and
  `ticket=` anyway, and the room's own log lines carry only an 8-character hash of the code and guest counts.
* Everything answers **only on the home network** unless the owner turns "only on my home network" off. A request
  through a proxy / the internet / Beebo's remote agent is not "home".
* A room the desktop app made *for a TV* (mode "on my TV") waits 15 minutes and is taken by the **first** device on the
  home network that opens `/tv` (a signed-in browser only takes its own person's room). Whoever takes it becomes the TV;
  the host guest and the lock still apply. Use "Show it on this computer" if that is a worry.
* Every POST is JSON, at most 2 KB, refused when it comes from another site. Replies are JSON; pages are self-contained.
* No user data becomes markup: nicknames, film titles, taglines and actor names go on screen only with `textContent`
  (tests scan the page code for every HTML sink), QR codes are drawn on a canvas from a 0/1 matrix, colours are used only
  when they match `#rrggbb`, the launch address must start with a single `/`. Answers, the join key and the overlay
  ticket never reach a phone; answers reach no screen before the reveal.
* Limits: 60 rooms, 3 open per address (the oldest closes), 8 rooms created per hour per address, 30 joins per 10 min
  per address, 60 actions / 10 s per ticket, 20 answers / 10 s, 8 reactions / 10 s per guest and 60 / 10 s per room,
  6 suggestions and 20 searches a minute, 900 requests a minute per address, 300 streams (16 per address; 2 per phone).
  A room ends 10 minutes after the last screen leaves, or after 10 hours.

## Files

`electron/movieNightGames.js` (rules, questions, scoring, vote) - `movieNightLibrary.js` (library -> pool) -
`movieNight.js` (rooms, tickets, clock, views) - `movieNightHttp.js` (routes, SSE, LAN address, QR) -
`movieNightWeb.js` + `movieNightClients.js` (pages and the three browser programs) - `movieNightIpc.js` (desktop button,
settings) - `src/components/MovieNightButton.jsx`, `MovieNightSettings.jsx` - `apps/smarttv/app/js/util/movienight.js`,
`screens/movienight.js`. Hooks in `streamServer.js`: the require lines, one wiring block, one public route line, one API
route block, one line in `playerPage`, the exported handle and its close. `corsPolicy.js` allows the two Movie Night API
calls for packaged TV apps.

Tests: `test/movie-night-games.test.js` (questions from a fixture library, scoring, teams, vote fairness, library
filtering), `movie-night.test.js` (rooms on a fake clock: lifecycle, timing, pause, permissions, limits),
`movie-night-http.test.js` (real server: live streams, full night, XSS, rate limits, cross-site, parental controls,
overlay), `movie-night-web.test.js` (no HTML sinks, ES5, self-contained, contrast, LAN address, SSE framing),
`apps/smarttv/test/movienight.test.mjs` (tile, contract, guarded navigation).

## What needs real TVs and phones

Not verified here (desktop Chrome and a simulated phone only):

* **Samsung Tizen / LG webOS / Xbox**: the Home tile, the app's move to the server's page (`location.assign` from a
  packaged `file://` app; Tizen may need `<access origin="*">` and the *Allow TV apps* setting on) and how Back returns
  (the page calls `history.back()`; the app restarts on Home). Focus ring and font size on a real panel; the
  pixelated poster on a weak GPU; the 2019 Chromium 63 engine.
* **Android TV WebView / Fire TV / Chromecast with Google TV / any smart-TV browser**: open `/tv`. Media-key Back
  codes (`4`, `10009`, `461`) are handled but not confirmed on hardware.
* **Phones**: iOS Safari and Android Chrome joining from a QR (camera app), the screen locking mid-game (the phone
  rejoins with its saved ticket), background tabs, vibration, the emoji glyphs of older phones, 12 phones at once
  on a real router (client isolation / guest Wi-Fi blocks phone-to-PC traffic and shows as "can't reach the server").
* **Sound** on a TV browser (autoplay rules), and a TV that never delivers a key press before the first sound.
* Whether the QR is scannable from across a real room at the sizes used.

## Deferred / follow-ups

* **Done 2026-09-21 (unverified on devices):** Android app (More > Movie Night: `POST /api/movie-night/tv/create`, then the TV page in a web view that can only visit the computer), Apple (Home shelf: web view on iPhone / iPad;
  tvOS has no web view, so it shows the address and a QR code to open elsewhere), Roku (a tab that checks `/api/movie-night/status` and shows the address to open on another device: no web view and no QR generator).
  Still open: drawing the room natively from `/movie-night-api/events` on Roku / Apple TV, and the page's Back key handling inside the Android web view (Back currently leaves the screen).
* Native players drawing reactions from the overlay ticket; a player-side "Movie Night" button that starts a room for the
  film being watched.
* Translations (the desktop Settings section, the TV page and the phone page are English only) and a right-to-left pass.
* More games (the Campsite game catalogue is the reference: bingo, spy, draw and guess) and a word filter option.
* Remembering scores between nights (deliberately not done: nothing is stored).
* A second host for the same room from another TV; guests from outside the home network through Beebo's remote path.
