# Parental controls, and the one content filter every route uses

Written 2026-09-17 (Eastern). Two audiences: the first half is for the owner, the second half is for
whoever writes the next feature that lists titles (playlists, music, photos, the car app).

---

## Part 1: what the owner gets

**Where:** desktop app > **Users** (per person, plus the owner PIN), or the phone app >
**Owner tools > Family & sharing**.

**Presets:** Young children (under 7), Ages 7 to 12, Teens (13 to 17), Off. Each sets a film and a
TV limit and hides unrated titles where that makes sense. After picking one you can fine-tune:

- **Highest rating** for films (US: G, PG, PG-13, R, NC-17; Canada: G, PG, 14A, 18A, R) and for TV
  (TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA).
- **Hide titles with no rating** (home videos, anything Beebo could not match).
- **Blocked genres**, **blocked titles**, **blocked collections**.
- **Only titles I allow** (an allow list: nothing else is visible at all).
- **A daily limit** in minutes, and **bedtime hours** (for example no watching 21:00 to 07:00). Both
  are answered with a friendly line rather than an error: "It's past bedtime on this profile.
  Watching opens again at 07:00."

**The owner PIN** (4 to 8 digits, stored only as a hash): asked for before anyone leaves a profile
that has parental controls, moves to a profile with more access, or changes a restricted profile's
limits on the device itself. Five wrong tries lock it for 15 minutes, per person and per device.

**A restricted profile can't reach:** the admin/owner tools, Settings (which is where Beebo Relay
lives), trailers and "look it up" links, requests for titles you don't have, or Space Saver. The
phone hides them; the server refuses them either way.

**This is not a "kid-safe mode" and not a child-directed app.** It is a tool for the adult who runs
the server. The Play build has no child-themed screens, and the audience declaration stays 18+.

**What it is enforced on:** every list, search, genre or actor filter, details page, episode list,
cast, collection, "Because you watched", Recently added, Surprise me, the watchlist, favourites,
history, the shared queue, the website, casting to a TV, and downloads. A title over the limit is
not just hidden: the server answers "not found" if the id is asked for directly, and the stream
refuses to play.

**Screen time is counted** in whole minutes while that profile is actually streaming or its player
reports progress. It resets at midnight, local time on the server.

---

## Part 2: the filter hook (for the next feature)

Everything above is one gate: **`desktop/apps/desktop/electron/contentGate.js`**. The rules it
applies come from `electron/parentalControls.js` (a member's limits) and
`electron/libraryShares.js` (what a guest from another household may see).

### The two things you need

Inside a request (every request on this server already runs inside the gate's scope):

```js
const contentGate = require('./contentGate')

// 1. A list of titles you are about to return:
items = contentGate.filterItemsForRequest(items)

// 2. One title, named by id (details, stream, playlist entry, cast, download):
if (!contentGate.allowIdForRequest('movie', id)) { /* answer 404 not_found */ }
```

`filterItemsForRequest` understands these item shapes, and passes anything else through untouched:

- `{ kind: 'movie' | 'tv' | 'show' | 'episode', id }`
- `{ showKey }`
- `{ stream: '/file?id=…' }` or `{ stream: '/tvfile?id=…' }`

Outside a request (a background job, a scan, the converter) there is no viewer and **nothing is
filtered** — that is deliberate: the owner's own maintenance must see the whole library.

### Why you usually don't have to do anything

The library walks themselves are already filtered. At the top of `streamServer.js`:

```js
const scanMoviesMulti = (dirs) => contentGate.filterForRequest('movies', rawScanMoviesMulti(dirs))
const scanTvShowsMulti = (dirs) => contentGate.filterForRequest('tv', rawScanTvShowsMulti(dirs))
```

So anything you build from `scanMoviesMulti` / `scanTvShowsMulti` / `apiShowMap()` is already
correct for the person asking. Call the hook when you hold ids that did **not** come from a walk:
saved playlists, history rows, a queue, ids in a request body.

### The other three layers (so you know they have your back)

1. **A pre-gate on ids in the request.** `parentalApiGate` in `streamServer.js` checks `?id=`,
   `?showKey=`, the show key in a path, and the ids in a POST body before any handler runs.
2. **A scrub on the way out.** Every JSON answer to a limited viewer goes through
   `gate.scrubJson()`, which drops disallowed items from arrays and nulls them elsewhere. This is a
   safety net for rows stored before a limit was set, not a licence to skip step 1.
3. **Viewer-bound media tokens.** A stream URL minted while a limited viewer is asking carries a
   token bound to that viewer (`makeMediaToken` -> `exp.sig.scope`). `/file` and `/tvfile` re-check
   the limits, bedtime, the daily limit and a share's streams-at-once on every range request, and a
   running stream is cut within a minute of a limit or a revoke. The token cannot be re-used for
   another id, and it cannot be stripped back to an unscoped one.

### Adding a new rule

Put the rule in `parentalControls.js` (`normalizePolicy` + `decide`) or, for shares, in
`libraryShares.js` (`cleanScope`) and `contentGate.checkInfo`. Nothing else needs to change: the
hook, the pre-gate, the scrub and the stream check all call the same decision.

### Tests to copy

`desktop/apps/desktop/test/parental-controls.test.js` runs a real server over a fixture library and
proves a restricted profile never sees or plays an over-limit title through any route family
(lists, search, details, episodes, credits, guessed stream URLs, cast/download URLs, the queue,
watchlist, favourites, surf, recommended, collections, the actor filter and the website), plus the
PIN, bedtime, the daily limit, and the whole share path. Add your route family to it.
