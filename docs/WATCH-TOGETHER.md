# Watch together

People in different places watch the same title from the same Beebo server, in step: play, pause, seek and
speed happen for everyone; a friend who joins late is caught up; the room waits when someone is buffering;
there is a small chat and emoji reactions. (Jellyfin SyncPlay / Plex Watch Together.)

Only people **signed in to this server** can take part. Nothing is relayed anywhere else: the room lives in the
server's memory, video still streams from the server to each person as usual, and only tiny control messages
are exchanged.

## Using it

**Web player** (any browser): open a movie or episode in the player, press **Watch together** in the top bar,
then **Start a room for this title**. Choose whether only you or everyone controls playback, press **Copy invite
link** and send it. Friends open the link, sign in if asked, and land in the player already in the room. (After
signing in you may be sent to the library: open the link again.) They can also paste the link or code into
the panel's "Have a code or link?" box.

**Desktop app**: on a movie's page (or an episode row) press **Watch together**. It starts a room, copies the
invite link (built from the address the app already uses for links: your `name.beebo.tv` address when set up,
otherwise the LAN address) and opens the player window with you as host.

In the panel: who is here (name, avatar colour, host / buffering / away badges), Speed, Next episode (when the
title has a next one), and for the host: everyone-can-control, pause-when-someone-buffers, chat on/off, make
host, remove. Reactions float up over the picture. **Leave room** / **End room for everyone**.

## How it stays in step

The server holds one **timeline** per room: `{ state, anchorPos, anchorAt, rate, seq }` - "at server time
`anchorAt` the film was at `anchorPos` seconds, running at `rate`". Everybody computes the playhead as
`anchorPos + (now - anchorAt) * rate` while playing. `seq` increases by exactly one for every accepted change, so a
viewer ignores anything older than what it has. Commands are applied one at a time in arrival order.

* **A synchronised start.** Pressing play sets `anchorAt` ~600 ms in the future; everyone sits on `anchorPos` until
  their own idea of server time reaches it, then plays. Nobody has to be told "go" at the same instant.
* **Clock offset (NTP style).** Each viewer pings `POST /ping` (6 quick samples on joining, then every 20 s),
  computes `offset = ((t1 - t0) + (t2 - t3)) / 2` and `rtt = (t3 - t0) - (t2 - t1)` and keeps the lowest-rtt
  sample. Browser clocks may be minutes off; only the offset matters. Accuracy is about half the difference between
  the outbound and return path delays, typically tens of ms.
* **Drift correction.** Every 250 ms the player compares its position with the timeline. Under 0.08 s: nothing.
  0.08 s to 1.5 s: the speed is nudged by `error / 2.5`, at most +-5 % (0.95x-1.05x, relative to the room's speed),
  which is imperceptible and never stutters; the nudge stops below 0.03 s (hysteresis). 1.5 s or more: a seek.
* **Joining mid-movie.** The join reply carries the timeline; the newcomer seeks to where the film is now and
  plays. A newcomer never stops a running room while loading: they only start to count ("ready") after their first
  report of being ready.
* **Waiting for people.** Each viewer reports ready / buffering and the timeline `seq` it has applied. If someone
  stalls while the room plays, the room pauses for everyone at that spot ("Waiting for Sam to buffer...") and starts
  again by itself, a moment ahead, when all are ready. A seek waits until everyone has landed on the new spot.
  Pressing play before a friend is ready waits for them too. A viewer that stays unready for 12 s stops holding
  the room up until they report ready again. The host can switch this off.

## Transport

No new dependencies and no WebSocket server (the server has none): **Server-Sent Events** for server to viewer,
plain **POST** for commands.

| | |
|-|-|
| `GET  /watch-together-api/events?code=` | SSE stream (cookie auth). Events: `state` (whole room), `chat`, `reaction`, `media`, `closed`, `kicked`. Heartbeat comment every 15 s. Reconnects replay missed chat via `Last-Event-ID`. |
| `GET  /watch-together-api/poll?code=&since=` | The same as one request, used automatically if a network breaks streams (polls once a second). |
| `GET  /watch-together-api/room?code=` | Title and host for an invite. |
| `POST /watch-together-api/create` `join` `leave` `command` `ready` `chat` `react` `settings` `transfer` `kick` `close` `ping` | JSON bodies. |
| `/api/watch-together/*` | The same routes for the apps, with a bearer token. |
| `GET  /watch-together/join?code=` | The invite link: redirects into the player (`/watch?id=...&wt=<code>`). The page removes `wt` from the address bar. |

Commands (`POST /command`): `{ code, type: 'play' | 'pause' | 'seek' | 'rate' | 'next', pos?, rate?, cid?, ifSeq?,
kind?/id? (next) }`. `cid` makes retries safe; `ifSeq` refuses a command sent from an out-of-date view.

## Security

* **Room codes** are 128 random bits (26 Crockford base32 characters), from `crypto.randomBytes`. A code lets you
  *ask* to join; you also need your own sign-in on this server. No anonymous access, and shared-library guests
  (who have no account here) cannot use the API.
* **Joining** checks the person may watch the title (parental controls, bedtime, file exists) and is limited to 20
  joins per 10 min per person. Wrong codes lock the person and their address out after 8 misses in 10 min (the same
  pattern as the parental PIN; misses are not wiped by a success). A removed person gets the same "not found" as a
  code that never existed.
* **Owner controls per room**: only the host changes settings, removes people (they are barred from that room),
  hands over the host role, changes the title or ends the room. With "everyone can control", others may
  play/pause/seek/change speed/next but still have no host powers. If the host leaves, the longest-standing
  connected person becomes host.
* **No user-controlled HTML.** Names, titles and chat are stripped of control, zero-width and bidi characters and
  length-capped (name 40, title 120, chat 300 characters) on the server, and the web panel only ever writes them
  with `textContent` (no `innerHTML`, `insertAdjacentHTML` or `document.write` anywhere in it; a test scans for
  that). Reactions are a fixed list. Room data reaches the page only as JSON; the script config is escaped for
  `</script>`. The invite landing page escapes everything it prints and never echoes the visitor's input. Media
  ids must match `[A-Za-z0-9_-]{1,700}` and links to a title are built by the server, never taken from a client.
* **Size and rate limits**: request bodies 4 KB; per person per room 40 commands / 10 s, 6 chat messages / 10 s, 10
  reactions / 10 s, 60 ready reports / 10 s; 300 requests / min overall; 6 rooms created / hour and 2 open per
  person, 200 rooms and 12 people per room; at most 3 streams per person; slow streams are dropped.
* **Cross-site**: every POST must be JSON and same-site (the cookie is sent with cross-site requests).
* **Logs** carry an 8-character hash of the code (`room 3fa9c1d2 closed`), never the code or a name, and the
  server's log redaction also masks `?code=` / `?wt=`.
* Rooms exist only in memory: a restart ends them. An empty or 12-hour-old room is closed.

## Files

`electron/watchTogether.js` (room manager) - `watchTogetherSync.js` (timing maths, shared with the browser by pasting
its source into the page) - `watchTogetherHttp.js` (routes + SSE) - `watchTogetherWeb.js` (player panel) -
`watchTogetherIpc.js` (desktop button) - `src/components/WatchTogetherButton.jsx`. Hooks in `streamServer.js`: the
require lines, one wiring block, three route blocks, one line in `playerPage`, and the log-redaction pattern.
Tests: `test/watch-together.test.js` (unit) and `test/watch-together-http.test.js` (real server, live streams).

## Known limits / not done

* Needs real multi-device testing over the internet (see the list in the change notes): actual sync quality, autoplay
  policy, Safari / iOS, background tabs, and a relay in front of the server buffering SSE (the polling fallback covers
  it, at about a second of latency).
* The Android / TV apps do not have the panel yet; the `/api/watch-together/*` routes are ready for them.
* Each person appears once per room (a second tab shares the seat).
* Auto-advancing to the next episode by the player's own "Up next" countdown is not coordinated; use **Next episode**
  in the panel (the host's choice moves everybody).
* The panel is not shown while the video is full-screen (the player's own full-screen target hides other page elements).
* No reconnection of a room after a server restart, no room list for the server owner, no invite by email.
