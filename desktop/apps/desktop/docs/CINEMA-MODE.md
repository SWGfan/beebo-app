# Cinema Mode (the pre-show)

A movie-theatre style pre-show before a film: an optional intro clip the owner chose ("Feature
Presentation"), then up to five trailers picked for the person and the film. **Off by default, per person.**
Built 2026-09-21. Status label for public copy: **In development** (needs the real-browser / TV checks at the
end of this file before it is called Available).

Code: `electron/cinemaMode.js` (picker, rules, settings, HTTP), `electron/cinemaOnline.js` (TMDB),
`electron/cinemaModeWeb.js` (the controller inside the web player), `electron/cinemaIpc.js` +
`src/components/CinemaSettings.jsx` (Settings > Playback > Cinema), a toggle in `src/components/MovieDetail.jsx`.
Tests: `test/cinema-mode.test.js`, `cinema-mode-http.test.js`, `cinema-mode-web.test.js`, `cinema-online.test.js`,
`cinema-ipc.test.js`.

## What a person sees

1. They turn it on for themselves: the owner in Settings > Playback > Cinema, anyone else with the
   **Pre-show** button in the web player's top bar (or the desktop Movie page's **Play with pre-show** box,
   which starts ticked when they have turned Cinema Mode on).
2. They press play on a film. The film is held (paused), a black layer opens, the intro plays, then each
   trailer, one after another. Under the picture there is always a bar with **Skip**, **Skip all** and
   **Don't show trailers**. Escape skips everything, Right arrow / N skips one.
3. When the last item ends (or Skip all) the film starts. If anything fails (offline, blocked, slow) that item
   is skipped; if everything fails the film simply plays.

The pre-show is never shown: when resuming a film part-way (unless "Play with pre-show" was asked for),
before TV episodes, in Surf mode, to a shared-library guest, or when the person picked "Never show trailers".

## Settings

Owner (server-wide, `store.cinemaConfig`, edited only from the desktop console):

| Field | Default | Meaning |
|---|---|---|
| `available` | true | master switch; false = nobody gets a pre-show (even when asked) |
| `allowOnline` | true | may online (YouTube/TMDB) trailers be used at all |
| `folder` | `<userData>/Cinema` | the Cinema folder (chosen with the native folder dialog, never typed) |
| `introFile` | none | a file name that exists in the Cinema folder (or `Intros/`) |
| `maxTrailers` | 5 | upper bound for everybody |
| `maxTrailerSeconds` | 240 | a trailer is cut off after this long (30 to 600) |

Per person (`store.cinemaPrefs[userId[:profile]]`, defaults in brackets): `enabled` (**false**), `neverShow`
(false; beats everything, including "Play with pre-show"), `count` (2, 0 to 5), `useIntro` (true), `sources`
`{local, owned, online}` (all true), `dedupeDays` (30, 0 = do not remember), `oncePerNight` (false) with
`nightGapHours` (6), `matchFeatureRating` (true).

The Cinema folder: intro clips in its root or in `Intros/`; generic trailers in `Trailers/` (name them with a
rating tag such as `Frozen 2 [PG].mp4` or `Saw (R).mp4`; an untagged file is treated as unrated).
Only browser-playable containers are used (`.mp4 .m4v .webm .mov .ogv`). The pre-show is never transcoded, so a
`.mkv`/`.avi` trailer is ignored.

## How the trailers are chosen (`cinemaMode.preroll`)

Three tiers; the picker takes one from each tier in turn (local, owned, online) until it has `count`, best
score first inside a tier (shared genres, nearby release year, nearby rating, a little seeded luck so the same
person + film + day gives the same answer):

1. **local**: a trailer file next to a library film, or in `Cinema/Trailers/`. Conventions found:
   `Film-trailer.mp4`, `Film_trailer`, `Film.trailer`, `Film - Trailer` (Kodi / Jellyfin / Plex), a shared
   `trailers/` folder holding `Film.mp4` or `Film-trailer.mp4`, and a per-film folder holding `Trailer.mp4`
   or `trailers/*`. Symlinks are ignored.
2. **owned**: a film the person owns and has not watched (their own watched marks) that has no local trailer;
   its official trailer is looked up through TMDB and played in the YouTube embed.
3. **online**: TMDB `recommendations` then `similar` for the feature (or `popular` when the feature is not
   matched), excluding anything already in the library. Same embed rule.

Rules applied to every candidate, after the network step (so the rating that TMDB reports is what is checked):

* **Parental gate.** A restricted profile is checked with `parentalControls.decide` on a copy of its policy with
  `blockUnrated` forced on: over the limit, unrated, blocked genre / title / collection, or not on the allow
  list = refused. A restricted profile that cannot see the feature at all is already refused by the existing
  gate (404) before this code runs. `RESTRICTED_API_BLOCKED` is not changed (`/api/trailer` stays blocked for them).
* **Theatre etiquette** (`matchFeatureRating`): never a trailer rated above the feature; before a G/PG film an
  unrated trailer or a horror-genre one is refused. A person can turn this off; a parental limit cannot be.
* **No repeats.** What the player reports as started (`POST .../preroll/seen`) is remembered per person by
  trailer and by title for `dedupeDays`; the intro is never recorded. Once per movie night uses the time of the last
  pre-show.
* **Offline / no key.** No TMDB key, TMDB unreachable or `allowOnline` off = the online tiers give nothing and
  local ones still play; the answer says `online: false | null`. TMDB answers are cached (7 days, `cinema-online.json`
  in the TMDB cache folder); a failed lookup is never cached. Only **official** YouTube trailers/teasers with an
  exact 11-character id are used. The network step has a time budget (about 4.5 s) and per-person rate limit.

Ratings use TMDB's US certification. A title with no rating is "unrated".

## HTTP contract (phones, TVs, the web player)

Signed in like every other API: a bearer token under `/api`, the login cookie under `/playback-api`
(POSTs on the cookie routes need a JSON content type, as for the rest of `/playback-api`).

### `GET /api/playback/preroll?kind=movie&id=<id>[&preshow=1|0][&resume=1][&profile=<name>]`

`id` is the same base64url id as `/api/playback/info`. `preshow=1` = the person asked for a pre-show for this play;
`preshow=0` = not this time; `resume=1` = the client is resuming part-way. Only films get a pre-show (`kind=tv` answers
`not_a_movie`). Always HTTP 200 with:

```json
{
  "ok": true,
  "enabled": true,
  "reason": "on",
  "wants": true,
  "skipAllowed": true,
  "maxTrailerSeconds": 240,
  "tmdbAttribution": "This product uses the TMDB API but is not endorsed or certified by TMDB.",
  "online": true,
  "partial": false,
  "items": [
    { "type": "local",   "role": "intro",   "url": "/cinema/media/<20 hex>?mt=<token>", "title": "Feature Presentation",
      "durationSec": 6, "attribution": "Your own intro clip.", "key": "i:..." },
    { "type": "local",   "role": "trailer", "url": "/cinema/media/<20 hex>?mt=<token>", "title": "Alpha (2019)",
      "durationSec": 92, "attribution": "A video file on this computer.", "key": "l:...", "titleKey": "t:m1" },
    { "type": "youtube", "role": "trailer", "videoId": "AbCdEfGhI01", "title": "Online Eleven",
      "durationSec": null, "attribution": "Trailer from YouTube, played in YouTube's embedded player. Movie information from TMDB.",
      "key": "y:AbCdEfGhI01", "titleKey": "t:m11" }
  ]
}
```

* `enabled: false` comes with `items: []` and a `reason`: `disabled | never | unavailable | off_this_time |
  resuming | once_per_night | guest | not_a_movie | bad_id | not_found`. `wants` = the person has Cinema Mode on
  (clients may remember it to hold the film at once next time).
* Items are in play order. `type: "local"` has a relative `url` (resolve it against the server address) that is
  a plain progressive video with byte ranges; `type: "youtube"` has **only** an id. `durationSec` may be `null`.
  `role` is `intro` or `trailer`.
* File paths never appear. Local urls are short-lived signed tokens (`checkMediaToken`, 12 h) bound to one file.

**What a client must do with it**

1. Validate before use: `videoId` must match `^[A-Za-z0-9_-]{11}$`; a local `url` must start with `/cinema/media/`.
   Show `title` / `attribution` as text, never as markup.
2. Play `youtube` items **only** with YouTube's official player (the IFrame Player API in a web view, or YouTube's
   own player library on a native client), unmodified and at least 200 by 200 px. Do not download, cache, extract
   audio, re-stream or proxy the video. Do not put anything over the player (keep Skip in a separate bar).
   Never call YouTube for an id you did not get from this endpoint. Show the `tmdbAttribution` line somewhere in the app.
3. Provide **Skip** (this item) and **Skip all** at all times. On any error, an embed that refuses to play,
   no network, or no start within ~15 s, skip that item; if the list ends or fails, play the film.
4. When an item really starts playing, tell the server so it is not repeated:
   `POST /api/playback/preroll/seen` with `{ "items": [ { "key": "...", "titleKey": "..." } ] }` (keys must match
   `^[a-z]:[A-Za-z0-9_-]{1,80}$`; the intro's `i:` keys are ignored; at most 12 per call). Do not report
   items that were skipped before they started.
5. A "Never show trailers" control should `POST /api/playback/cinema` `{ "neverShow": true }`.

### Other routes

* `GET /api/playback/cinema` returns `{ prefs, available, onlineAllowed, hasIntro, maxTrailers, hasFolder }`;
  `POST` merges any of the per-person fields above (junk is clamped) and `{ "clearHistory": true }` forgets which trailers were seen.
  A person can only ever change their own settings.
* `GET /api/playback/cinema/coming-soon` returns TMDB "coming soon" / "in cinemas" **information cards**
  `{ tmdbId, title, releaseDate, overview, posterPath }` with `attribution`; nothing playable. A restricted
  profile gets `restricted: true` and empty lists (the cards carry no age rating).
* `GET /cinema/media/<id>?mt=<token>` (no login; the signed token is the credential, like `/hls`): the file,
  with ranges. Only files under a library movie folder or the Cinema folder, with a playable extension, are ever registered.

## The web player (`cinemaModeWeb.js`)

`playerPage` adds one line after the `<video id="v">`. The script is an ordinary function (`clientMain`) whose source is
emitted into the page (ES5-style for TV browsers; tested against a fake DOM). It holds the film at once when
`?preshow=1` is in the address or the person's `beebo:cinema` hint (localStorage) is on, asks for the list, plays it,
then releases the film. A slow or failing server releases the film after 9 s. YouTube items are an `<iframe>` on
`https://www.youtube-nocookie.com/embed/<id>` with `referrerpolicy="strict-origin-when-cross-origin"` that the
official IFrame API (`https://www.youtube.com/iframe_api`) attaches to. Everything shown is set with `textContent`.

`httpSecurity.js` (report-only CSP) now lists `frame-src https://www.youtube-nocookie.com` and
`script-src ... https://www.youtube.com`, and nothing else new.

## Legal notes (read before turning this on for anyone)

* **YouTube.** Trailers from YouTube are played only through YouTube's embedded player (IFrame Player API), in the
  person's own browser or app window, with the player and its controls unmodified and not covered. Beebo never
  downloads, caches, extracts, re-streams or proxies YouTube video or audio, and never scrapes YouTube. The video
  ids come from TMDB's own `videos` data (only ones TMDB marks official). Videos whose owner disabled embedding just
  fail to play and are skipped. YouTube's API Services Terms of Service and Developer Policies apply to this use:
  the app's own terms/privacy text should say that using the online trailers is subject to YouTube's Terms of Service
  (https://www.youtube.com/t/terms) and Google's Privacy Policy (https://policies.google.com/privacy), and that
  playing one contacts YouTube from the viewer's device (`youtube-nocookie.com` is the privacy-enhanced domain). **This wording
  is for the owner and the lawyer to approve; nothing has been published.** The feature is off by default and the owner can
  disable online trailers server-wide (`allowOnline`) or a person per source.
* **TMDB.** Data comes through the existing TMDB key under TMDB's API terms; the attribution line
  ("This product uses the TMDB API but is not endorsed or certified by TMDB.") is shown with online trailers, on the coming-soon
  cards and in settings, and is returned in the API. TMDB's terms distinguish commercial use: confirm Beebo's position
  (the app is free, optional services are paid) with the lawyer, as for the rest of the TMDB use.
* **Local trailers** are the owner's own files, played from the owner's computer to people in the household.
* **Children.** The rating rules are a filter, not a guarantee (ratings come from TMDB and can be missing or wrong); a
  restricted profile refuses anything unrated. This is a tool for the adult who runs the server; no child-directed claims.

## Known limits

* Local trailer files are not hidden from the library lists (`Film-trailer.mp4` still shows as a "film"); the picker
  ignores them, but a scan-level exclusion in `catalog.js` would be a good follow-up.
* Trailers of TV shows are not offered (film trailers only). No pre-show for episodes or Surf mode.
* Casting / AirPlay start the film only (the pre-show plays in the browser page, not on the cast device).
* Ratings are the US certification; a Canadian-only rating is read as its US equivalent where one exists.
* Whole-file `durationSec` for local items needs ffprobe; otherwise it is `null`. YouTube durations are not known.
* The Electron player window's permission handler denies "fullscreen" to YouTube's frame, so the embed's own
  fullscreen button may not work there (the page itself is not affected).

## What needs a real browser or TV to verify

Not provable in unit tests (the fake-DOM and HTTP tests cover the logic, contract, validation and failure paths):

1. A real YouTube trailer plays and ends inside the embed, on Chrome, Edge, Firefox, Safari (macOS + iPhone inline),
   Android Chrome, and the desktop app's player window. In particular that YouTube accepts the embedding page's referrer
   for a **LAN `http://192.168...` origin** and for the `https://<name>.beebo.tv` origin (YouTube refuses embeds that send no referrer);
   what the player shows when a video's owner disabled embedding; that `onError`/no-start skips cleanly.
2. Autoplay rules: sound-on autoplay of the first item after a click from the library, and the muted-start fallback for local items.
3. Samsung Tizen / LG webOS / Android TV / Fire TV browsers: the IFrame API loads, `referrerpolicy` on iframes is honoured,
   the remote reaches Skip (it is focused first), Escape/Back maps to Skip all.
4. Holding the film: no audible blip of the film on the first play before a person's hint exists, and the film starts by itself
   after the pre-show on iOS/Android (autoplay after an async gap).
5. The CSP report-only log shows no new violations from the YouTube script/frame; the frame-ancestors rule is unaffected.
6. The Movie page toggle really opens the pre-show in the desktop app's player window, and the settings screen layout
   (ChatGPT visual pass is welcome; behaviour is done).
7. Real ffprobe durations for the local items; a very large local trailer over a slow Wi-Fi.
8. Native TV / phone apps: not built; they follow the contract above.
