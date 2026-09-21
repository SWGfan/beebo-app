# Jellyfin-compatible API mode - plan and gap map

Status: Phase A (this document) and Phase B (implementation in `electron/jellyfin/`); hardening pass 2026-09-21 (conformance suite, WebSocket,
app passwords, tracked sessions, Settings panel). Per-client call lists, status and the public compatibility table: `docs/JELLYFIN-CLIENT-MATRIX.md`.
Setting: `jellyfinCompat` (owner toggle, default OFF). Labelled in the UI as "Jellyfin-compatible API".

## 0. Legal and honesty posture

- The mode implements a compatible HTTP interface. No Jellyfin server source was read or copied
  (it is GPL); the route table and DTO shapes were written from the public API documentation,
  from what the public OpenAPI document exposes, and from the observable requests that client
  apps send. No Jellyfin logos, names or artwork are used; the text "Jellyfin-compatible API"
  is nominative use only.
- The server never claims to be Jellyfin. `ServerName` is the Beebo server's own name and
  `ProductName` is `Beebo Entertainment`. Clients gate on `Version`, so the server reports
  `COMPAT_API_VERSION` (see `electron/jellyfin/constants.js`) and additionally returns a
  Beebo-specific `BeeboCompat` object in `/System/Info/Public` saying what it is.
- Spec: the first version of this mode was written from documentation because the fetch tool returned only part of the OpenAPI
  document. Since 2026-09-21 the complete public description (12.1.0) is a test fixture
  (`test/fixtures/jellyfin-openapi-12.1.0.json`, trimmed to the routes Beebo serves by `tools/jellyfin-openapi-trim.js`), and
  `test/jellyfin-conformance.test.js` validates every answer against it. The per-client call lists and the honest status of each app are in
  `docs/JELLYFIN-CLIENT-MATRIX.md`. No real app has been run against Beebo: every app is UNTESTED.

### Version value (decision, revised 2026-09-21)

Clients gate on `Version`: Jellyfin Web and the TypeScript SDK 1.0 need 10.10+, Android TV's development branch and Findroid 1.0 need 10.11+,
and the Kotlin SDK's development branch wants 12.0+. The newest stable Jellyfin is 12.1 and the conformance suite checks against its
description, so `Version` is reported as `12.1.0` and `BeeboCompat.api` says `12.1-level subset`. The older routes those clients still use
(`/Users/{id}/Items`, the `/emby` prefix) and every legacy token form stay served. Change one constant (`COMPAT_API_VERSION`) to move it.

## 1. What Beebo has (read from the code, not assumed)

| Area | Where | Notes |
| --- | --- | --- |
| HTTP entry | `streamServer.js` `handleRequest` (all requests) -> `/hls/*` and `/subtitles/embedded` via `playbackApi.handlePublic`, `/api/*` via `handleApiRequest`, then the cookie-session website | One port (47811), plain HTTP and TLS on the same port |
| API auth | `Authorization: Bearer userId.exp.sig` (`makeApiToken`/`verifyApiToken`, 365 days, live status re-check, privacy salt) | Login: `attemptLogin` (IP + per-username + global lockout, admin probe alert, failed login recording) |
| Gate | `parentalApiGate` + `contentGate` (library walks filtered by request viewer, `scrubJson` on limited viewers, media tokens bound to the viewer `u:<id>`) | Every Beebo route is filtered here; the compat mode reuses it (see 3) |
| Movies | `GET /api/movies` items: `id` (base64url of file name), title, year, poster (server-relative `/media/poster/<tmdbId>.jpg` or null), backdrop (TMDB CDN url), voteAverage, genres (TMDB ids), overview, collectionId/Name, tmdbId, `stream` (`/file?id&mt`) | No runtime, no rating text, no cast (cast: `/api/credits`) |
| TV | `GET /api/tvshows` (key = base64url of lowercase show name), `GET /api/tvshows/<key>/episodes` (seasons -> episodes: id = base64url of relPath, season, episode, title, episodeName, watched, watchedPercent, `stream` (`/tvfile?id&mt`)) | TMDB show art; no per-episode still |
| Resume/history | `history.continueWatching/resumeFor` (currentTime, duration), `watchedState.userFiles` (one answer to "watched"), `libraryFlags[user]['movie:<id>'].favorite` | Session model: `POST /api/watch-session` -> `sessionId`, then `POST /api/progress {sessionId,currentTime,duration}` |
| Playback | `GET /api/playback/info?kind&id` (duration, video/audio/subtitle tracks, qualities, direct verdicts), `POST /api/playback/start` -> signed HLS ticket `/hls/<ticket>/index.m3u8` (whole-file VOD, `seg-N.ts`), 1080p/720p/480p H.264/AAC, audio track pick, burn-in of picture subtitles | Direct file: `/file?id&mt` and `/tvfile?id&mt` with Range; embedded text subs `/subtitles/embedded?kind&id&s&mt` (WebVTT); sidecars `/subtitles/file?kind&id&i&mt` |
| Music | `/api/music/{artists,albums,tracks,artist/:id,album/:id,search,cover/:id,track/:id/stream}` | Not content-gated (the same for every account) |
| Images | `/media/poster/<tmdbId>.jpg` (w300 cache), `/media/poster-tv/<tmdbId>.jpg`, `/media/actor/<id>.jpg` - public, unauthenticated | Backdrops are TMDB CDN urls only; no logos, no thumbs, no resizing code (no `sharp`) |

Beebo ids are file-name/relative-path based, not hashes. That is why the compat layer maps ids
rather than passing them through.

## 2. Routing approach

- Same port and host as Beebo. One early hook in `handleRequest`, after the license gate and before the `/hls/` branch:
  `jellyfinCompat.claims(pathname)` tests the path against the compat route table (pure regexes, no settings
  read); only a claimed path reaches `handle()`, which then reads the `jellyfinCompat` setting (electron-store
  re-reads its file on every `get`, so it is never read for ordinary Beebo traffic).
- Jellyfin paths are case-insensitive (`/system/info/public`, `/Items`, `/items`): every route template
  (`/Items/{itemId}/Images/{imageType}/{imageIndex}`) compiles to a case-insensitive regex; parameter values keep their
  case. `/emby/...` and `/mediabrowser/...` prefixes (older clients, Kodi) are stripped, and a trailing slash is allowed.
  Two generic stubs (`/Playlists`, `/Collections`) match only in their canonical case because Beebo owns lowercase
  `/playlists`.
- Flag OFF: every claimed path answers a plain 404 (so a Jellyfin app reports "not a Jellyfin server" instead of being
  bounced to the Beebo login page); a path that is not claimed falls through to the normal Beebo handlers unchanged.
  Beebo's own paths are never claimed: a test enumerates every literal route of `streamServer.js` against the table.
- Paths owned by Beebo stay owned by Beebo: `/hls/*`, `/file`, `/tvfile`, `/media/*`, `/api/*`,
  `/subtitles/*` are never claimed. The compat layer hands out Beebo urls (e.g. `/hls/<ticket>/index.m3u8`)
  where that is the right thing to play.

### Delegation (the security property)

The compat layer NEVER reads the library on its own to decide what a person may see. It calls
Beebo's own API in-process, as the token's user, through `host.api(userId, method, path, body)`
(a synthetic request dispatched into `handleRequest` with a Beebo bearer token minted for that
user inside the process). So:

- `parentalApiGate` (blocked title, restricted profile blocked routes, bedtime, daily limit),
  `contentGate` filtering of the library walks and `scrubJson` apply exactly as for the phone app;
- private-history profiles, guests (share tokens are refused by the compat login), admin-only data
  behave as in the Beebo routes;
- an item id that is not in the token user's own catalog is a 404, whatever id the client sends.

Own-user state (watched, resume position, favourites) is read directly from the token user's records
(`watchedState`, `history`, `libraryFlags`); it is never keyed by anything the client supplies.
Writes (`played`, `favourite`, progress) go through Beebo's API routes so their gates and side effects
(webhooks, watch-session bookkeeping, the parental usage counter) all still run.

## 3. Authentication

- `POST /Users/AuthenticateByName {Username, Pw}` -> `host.attemptLogin({ip, username, password})`:
  the same function the website and phone use, so IP/username/global lockout, failed-login records
  and admin alert emails apply. 401 on bad credentials, 429-style body on lockout, guests refused.
  Legacy `Password`/`Pw` both read. There is no second password check anywhere.
- Access token = `jf.` + Beebo bearer token (`makeApiToken`). It is opaque to clients. It works only on
  the compat routes: Beebo's `/api` rejects it (its userId would be `jf.<id>`), and Beebo bearer tokens are not
  accepted by the compat routes (must carry the `jf.` prefix). It dies the same moment the Beebo token does
  (revocation, deletion, privacy change).
- Every sign-in is a **tracked session** (`authSessions`, method `jellyfin`, `app password` or `quick connect`): it is listed in the person's
  device list and in Settings > Jellyfin apps, and "Sign out" (from the app's Logout, `DELETE /Auth/Keys/{own token}`, the owner's
  Settings, or Beebo's own device list) removes the record, so it survives a restart. The old in-memory revocation set stays as a second lock.
- **Two-factor accounts** cannot use the password sign-in (unchanged: the password alone is never a sign-in, and these apps have no place for a
  code). The 401 says what to do instead: the owner makes an **app password** for that app in Settings > Jellyfin apps
  (`electron/jellyfin/appPasswords.js`): 16 characters in four groups (80 bits), shown once, stored only as a SHA-256, per person and per app,
  accepted only by `POST /Users/AuthenticateByName` on these routes, throttled (8 misses per address and per person per 15 minutes) on top of Beebo's
  own lockout, recorded in the security log, deletable at any time. The session it opens is an ordinary restricted-by-policy Jellyfin session.
- Missing `Client` or `DeviceId` in the Authorization header (Apple-style clients omit them) never fails a request.
- Token sources, in order: `Authorization: MediaBrowser Client="..", Device="..", DeviceId="..", Version="..", Token=".."`,
  `X-Emby-Authorization` (same syntax), `X-MediaBrowser-Token`, `X-Emby-Token`, `?api_key=` / `?ApiKey=`.
  Device info is parsed for the sessions list only; it is never trusted for anything security relevant.
- Quick Connect (in-memory, inside the server): `/QuickConnect/Enabled` (true when the mode is on),
  `POST /QuickConnect/Initiate` (6-digit code + secret, 5 minutes, max 20 pending, rate limited per IP),
  `GET /QuickConnect/Connect?secret=`, `POST /QuickConnect/Authorize?code=` (needs a signed-in compat token; the
  device then signs in as THAT user), `POST /Users/AuthenticateWithQuickConnect {Secret}`. Wrong-code attempts by
  a signed-in user are limited (10 per 5 minutes). Restricted profiles stay restricted: the new device receives
  a token for the authorising user only, exactly the access that user has.
  The **owner can approve from the desktop** (Settings > Jellyfin apps): the pending list shows code, app and device (never the secret) with
  an Approve button, or a code can be typed and a person chosen; the device then signs in as that person. Wrong codes are throttled the same way.
- `/Users/Public` returns `[]` (no user enumeration for anonymous callers).

## 4. Id scheme

Jellyfin ids are 32 hex characters (16 bytes).

```
byte 0        type tag: 01 movie, 02 series, 03 season, 04 episode, 05 view/library, 06 person,
              07 genre, 08 boxset, 09 user, 0a music artist, 0b music album, 0c audio track,
              0d playlist, 0e studio
bytes 1..15   HMAC-SHA256(serverKey, tag || 0x00 || canonicalKey) truncated to 15 bytes   (hashed kinds)
              or big-endian integer in bytes 8..15 with zero padding                        (numeric kinds)
```

- Hashed kinds (movie, series, season, episode, music, user): the canonical key is the Beebo id
  (`movie:<fileNameId>`, `series:<showKey>`, `season:<showKey>:<n|x>`, `episode:<relPathId>`, `user:<id>`).
  Reverse mapping is by looking the id up in the token user's own catalog index, which is rebuilt from the
  library (no persisted id database, nothing to migrate or corrupt). The `serverKey` is generated once and
  stored (`jellyfinIdKey`), so ids are stable across restarts and cannot be computed by someone who knows a
  file name (an id learnt for a title cannot be derived for another, and a restricted profile cannot probe
  for blocked titles).
- Numeric kinds (person = TMDB person id, genre = TMDB genre id, boxset = TMDB collection id, view = fixed
  small integers, studio): fully reversible arithmetic, no index needed.
- Property tests: encode/decode round trip for numeric kinds, uniqueness and determinism for hashed kinds,
  the tag byte always decodes, a malformed id is rejected, 15-byte truncation has no collisions across a
  10 000 title synthetic library.
- Image ids: images are anonymous in the Jellyfin API (`<img src>` cannot send headers). Image requests are
  answered only for ids that were already handed to a signed-in user (a bounded registry filled while DTOs
  are produced) and only ever serve public TMDB art.

## 5. Data-model mapping

| Jellyfin | Beebo |
| --- | --- |
| Users, `UserDto`, `Policy` | `authUsers`; `IsAdministrator` = admin and NOT restricted; `EnableAllFolders` true; restricted profile -> `MaxParentalRating` from the policy, `EnableContentDeletion` false, `EnableRemoteControlOfOtherUsers` false, admin flags false, `EnableMediaConversion` false |
| Libraries (`/UserViews`) | one view per non-empty section: Movies (`CollectionType movies`), TV Shows (`tvshows`), Music (`music`), Collections (`boxsets`). Photos/private vault are NOT exposed (`homevideos` is not offered: the photo library is personal and has no Jellyfin-shaped browse in Beebo) |
| Movie | `/api/movies` item |
| Series / Season / Episode | `/api/tvshows` + `/api/tvshows/<key>/episodes`; Season id derived from (show, season number); unsorted episodes (no season) are Season 0 "Specials"-style "Unsorted" |
| BoxSet | `/api/collections` (TMDB collections) |
| MusicArtist / MusicAlbum / Audio | `/api/music/*` |
| People | `/api/credits` cast (name, character, TMDB person id) -> `People[]` (Type Actor) |
| Genres | TMDB genre ids and Beebo's own name tables (via the item lists) |
| UserData | `watchedState` (Played), `history.resumeFor` (PlaybackPositionTicks), `libraryFlags` (IsFavorite); PlayCount 1 when watched |
| Resume / NextUp / Latest | `history.continueWatchingGrouped` via `/api/continue`; `/api/upnext`; `/api/recently-added` |
| Playback progress | `/api/watch-session` + `/api/progress`, session id kept in memory per play session |
| Image types | Primary = cached TMDB poster; Backdrop = TMDB backdrop (302 to the CDN with size picked from `maxWidth`); Logo/Thumb/Banner/Disc = none (empty `ImageTags`, 404) |

Also mapped since 2026-09-21: Beebo playlists -> `Playlist` items and a Playlists view (read only), Beebo's preview frames -> `Trickplay` tile
sheets, intro/credits markers -> `Intro`/`Outro` media segments, ffprobe chapters -> `Chapters` (names and times only), music genres (a stable id from
the genre name), Instant Mix, Suggestions, Similar, and a persisted "date added" (first time the mode saw the item, `jellyfinFirstSeen`) for `DateCreated`.

Left unsupported and answered safely (empty lists / 204 / 403 / 404 - never a crash): Live TV, Channels, Plugins, Packages,
SyncPlay, Devices admin, Scheduled tasks, Library management, Startup wizard, Notifications, all admin endpoints
(`/System/Restart`, `/System/Shutdown`, `/Users` create/delete, `/Auth/Keys` create, ...), Collections/Playlists write,
remote control of another app, lyrics (404), item updates/deletes (403).

## 6. Minimum endpoint set per target client

Derived from public client behaviour; "unverified" = not exercised against the real app here.

| Client | Needs beyond the core set |
| --- | --- |
| Jellyfin web (custom static build) | `/web/` is not served (clients are separate apps); `DisplayPreferences`, `/Branding/Configuration`, `/Localization/*` (stubs) |
| Android TV, Android (Findroid), Kodi JellyCon, Samsung/LG/Roku, Xbox | System/Info/Public, Users/AuthenticateByName, Users/Me, UserViews, Items (+Latest, Resume, Filters), Shows/NextUp|Seasons|Episodes, Items/{id}/PlaybackInfo, master.m3u8 / stream, Sessions/*, UserPlayedItems, UserFavoriteItems, Images, Genres, Persons, Search/Hints, Sessions/Capabilities |
| Swiftfin (iOS/tvOS) | same as above plus `/Users/{id}/Items/...` legacy forms, `DisplayPreferences`, `QuickConnect`, HLS `master.m3u8` with `TranscodingUrl` |
| Finamp (music) | Artists, Artists/AlbumArtists, MusicAlbums via Items, Audio/{id}/universal, Playlists (empty), Items?IncludeItemTypes=Audio |
| Infuse | Not verified to support custom Jellyfin servers; treated like Swiftfin |

## 7. Coverage (as implemented)

S = supported (real data), P = partial, T = stub (a correct, empty or fixed answer so clients do not crash), U = unsupported (403/404/405).
All paths are case-insensitive, accept an optional `/emby` or `/mediabrowser` prefix and a trailing slash.

| Endpoint | Status | Notes |
| --- | --- | --- |
| GET /System/Info/Public | S | anonymous; `ProductName` Beebo Entertainment, `Version` from `COMPAT_API_VERSION`, `BeeboCompat` marker |
| GET /System/Info, /System/Endpoint | S / T | any signed-in user; no paths or OS details |
| GET,POST /System/Ping | S | anonymous |
| POST /System/Restart, /System/Shutdown | U | 403 |
| GET /Branding/Configuration, /Branding/Css(.css) | S | empty branding |
| POST /Users/AuthenticateByName | S | shared `attemptLogin` (lockout, alerts); `Pw` or `Password` |
| GET /Users/Public | T | always `[]` |
| GET /Users/Me, /Users, /Users/{id}, /Users/{id}/GroupingOptions | S | only the caller; another id is 403 |
| POST,DELETE /Users/{id}/Password | U | 403 (use Beebo) |
| QuickConnect: Enabled, Initiate, Connect, Authorize, AuthenticateWithQuickConnect | S | in memory, 5 minute codes, rate limited |
| GET /UserViews, /Users/{id}/Views | S | Movies, TV Shows, Collections, Music (only non-empty ones) |
| GET /Items, /Users/{id}/Items | S | ParentId, Ids, IncludeItemTypes, ExcludeItemTypes, MediaTypes, Recursive, SearchTerm, Filters (IsPlayed, IsUnplayed, IsFavorite, IsResumable), IsFavorite, IsPlayed, Genres, GenreIds, Years, PersonIds, NameStartsWith*, SeriesId, SortBy (SortName, DateCreated, PremiereDate, ProductionYear, CommunityRating, DatePlayed, PlayCount, IndexNumber, ParentIndexNumber, Album, AlbumArtist, Artist, Random), SortOrder, StartIndex, Limit |
| GET /Items/{id}, /Users/{id}/Items/{id} | S | People from cached cast, MediaSources with real tracks (ffprobe), library ids open as folders |
| GET /Items/Latest, /Users/{id}/Items/Latest | S | plain array |
| GET /Items/Resume, /UserItems/Resume, /Users/{id}/Items/Resume | S | from Beebo's continue list |
| GET /Items/Filters, /Items/Filters2 | S | genres and years present |
| GET /Shows/NextUp, /Shows/{id}/Seasons, /Shows/{id}/Episodes | S | Unsorted files become an "Unsorted" season |
| GET /Shows/Upcoming | T | empty |
| GET /Genres | S | TMDB genres present in the library |
| GET /Search/Hints | S | movies, series, albums, artists, songs |
| GET /Artists, /Artists/AlbumArtists | S | Music library |
| GET /Persons, /Studios, /Years, /Trailers, /Channels, /Devices, /Collections, /Movies/Recommendations, /Library/MediaFolders | T | empty (`/Playlists...` and `/Collections` only in canonical case, because Beebo owns `/playlists`) |
| GET /Items/Suggestions (and /Users/{id}/Suggestions), /Items/{id}/Similar (+ Movies, Shows, Albums, Artists forms) | S | unwatched films and shows, seeded per hour; genre-overlap similar |
| GET /MusicGenres, /Items/{id}/InstantMix (+ Songs, Albums, Artists, Playlists, MusicGenres forms), /Items/{id}/File | S | genres from the person's albums and tracks; a run of tracks from the seed; the file with Range |
| GET /Playlists/{id}, /Playlists/{id}/Items, Items?IncludeItemTypes=Playlist, a Playlists view | P | the person's Beebo playlists, read only; POST/DELETE answer 403 |
| GET,POST /UserItems/{id}/UserData | S | POST honours `Played` and `IsFavorite` only |
| GET /Playback/BitrateTest, DELETE /Videos/ActiveEncodings, POST /Users/Configuration, POST /Devices/Options, DELETE /Auth/Keys/{own token} | S | random bytes up to 10 MB; the rest 204 / own token only |
| GET /Plugins, /Packages, /ScheduledTasks, /Library/VirtualFolders, /Localization/*, /Notifications/Services, /Repositories | T | empty arrays |
| /LiveTv/* | T | disabled, empty |
| GET /Items/{id}/Images/{type}[/{index}] | P | Primary (cached poster or cover, served by Beebo's own image route; an episode's Primary is the show's backdrop because Beebo has no episode stills), Backdrop and Thumb (302 to the TMDB CDN, size from `maxWidth`); Logo, Banner, Disc are 404. No resizing of cached art (posters are already w300). With the item's `tag` the answer is cacheable for a year and answers `If-None-Match` with 304 |
| GET /Items/{id}/Ancestors, Intros, LocalTrailers, SpecialFeatures, ThemeMedia, ThemeSongs, ThemeVideos | T | empty |
| GET /MediaSegments/{id} | S | `Intro` and `Outro` from viewer-set and auto-detected markers (`includeSegmentTypes` honoured); `HasSegments` on the media source |
| BaseItemDto.Trickplay, GET /Videos/{id}/Trickplay/{width}/{index}.jpg, tiles.m3u8 | S | 10 x 10 tile sheets built from Beebo's preview frames with the bundled ffmpeg (kept in a small memory cache); present once Beebo has made the frames |
| GET /Items/{id}/Download | U | 403 |
| POST,GET /Items/{id}/PlaybackInfo | S | DeviceProfile aware direct play, otherwise an HLS `TranscodingUrl`; bedtime and daily limit answer `NotAllowed` |
| GET /Videos/{id}/master.m3u8, main.m3u8 | S | starts a Beebo HLS ticket (H.264/AAC, 1080p/720p/480p); honours AudioStreamIndex, burnt-in picture subtitles, bitrate |
| GET,HEAD /Videos/{id}/stream[.ext] | S | `static=true` is the original file with Range through Beebo's own `/file` and `/tvfile` (dashboard, away-quality cap, parental gate); otherwise 302 to master.m3u8 |
| GET /Videos/{id}/{source}/Subtitles/{index}[/{ticks}]/Stream.{vtt,srt} | S | embedded and sidecar text subtitles; picture subtitles are burnt in |
| GET /Audio/{id}/stream, /universal | S | Beebo's music stream route (transcodes to AAC/Opus when the client cannot decode the codec) |
| POST /Sessions/Playing, /Progress, /Stopped, /Ping | S | mapped to `/api/watch-session` + `/api/progress`; runtime from the probe |
| POST /Sessions/Capabilities, /Capabilities/Full | T | 204 |
| GET /Sessions | P | only the caller's own apps, with `NowPlayingItem` and `PlayState` while they report playback |
| POST /Sessions/Logout | S | ends the tracked session (persists over restarts) |
| POST,DELETE /UserPlayedItems/{id}, /Users/{id}/PlayedItems/{id} | S | movies, episodes, seasons, series |
| POST,DELETE /UserFavoriteItems/{id}, /Users/{id}/FavoriteItems/{id} | S | movies, episodes, series |
| GET /UserItems/{id}/UserData | S | |
| GET,POST /DisplayPreferences/{id} | P | kept in memory per person |
| WebSocket /socket | S | RFC 6455 without a dependency (`electron/jellyfin/websocket.js`): token from `api_key`/`ApiKey`/header, `ForceKeepAlive` then `KeepAlive`, `SessionsStart/Stop` (own sessions), `UserDataChanged` pushes to the same person's sockets; 64 KB frames, 8 sockets per person, 100 in all, dropped after 3 minutes of silence or when signed out. No `Play`/`Playstate`/`GeneralCommand`, no `LibraryChanged` |
| SyncPlay, remote control of another app, admin and management endpoints | U | not implemented |

## 8. Known limits and honest caveats

- Not verified against a real Jellyfin app: no such client could be run here (see the final report). The tests speak the protocol the way the public documentation and client behaviour describe it.
- The WebSocket carries keep-alive, the person's own session list and item-mark changes only: no remote control, no library-changed nudges.
- No lyrics, theme media, live TV, downloads, sync play; chapter thumbnails are not made.
- Some apps' setup libraries refuse a server whose product name is not Jellyfin's (`docs/JELLYFIN-CLIENT-MATRIX.md` section 5): an open owner decision.
- Item ids are stable across restarts as long as the `jellyfinIdKey` setting is kept (it is part of a backup); restoring an older backup changes them and apps re-sync their library on next sign-in.
- Sign-out is a tracked Beebo session record, so it survives a restart. Tokens are valid 365 days like the phone app's, and every one is listed under Settings > Jellyfin apps and can be ended there. Tokens issued by an older build of this mode (before 2026-09-21) carry no session record and end only with "sign out everywhere"; the apps simply sign in again.
- The catalog is refreshed at most every 30 seconds (episodes 60 seconds): a file that was just added can take up to that long to appear.
- The compat token appears in `api_key=` query strings that the apps build (Jellyfin's own convention); Beebo redacts `api_key` in its logs.
