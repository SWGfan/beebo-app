# Jellyfin-compatible API mode: client matrix

Written 2026-09-21 for Beebo's "Jellyfin-compatible API" mode (setting `jellyfinCompat`, off by default; code in `electron/jellyfin/`;
plan and design in `docs/JELLYFIN-COMPAT-PLAN.md`). This file answers three questions: which calls does each popular Jellyfin app make,
what does Beebo do for each, and what may we honestly tell people.

**Honesty rule for everything below.** Nobody has run any of these apps against Beebo. Every statement about a real app is derived from
its public source or documentation and from a protocol-level test of Beebo, and is labelled **UNTESTED** until someone runs the app.
The only "real client" run so far is the official typed TypeScript SDK (`@jellyfin/sdk` 1.0.0), driven end to end by
`test/jellyfin-sdk-e2e.test.js`. That proves the wire format, not any particular app.

**Wording rule.** Say "compatible with Jellyfin apps" or "Jellyfin-compatible API". Beebo is not Jellyfin, never claims to be, and does not use
Jellyfin's name or logo as its own. No Jellyfin server or client source was copied (GPL); the public OpenAPI description
(api.jellyfin.org, MPL-2.0 data) and `@jellyfin/sdk` (MPL-2.0) are used only as test tools and are not shipped.

---

## 1. Snapshot of the ecosystem (facts, with sources)

| Fact | Source |
| --- | --- |
| Latest stable Jellyfin server is 12.1 (2026-09-15), 47 fixes and no API change from 12.0 (2026-09-08). The planned "10.12" shipped as 12.0. Last 10.x is 10.11.11. | https://github.com/jellyfin/jellyfin/releases/tag/v12.1 |
| The public OpenAPI description reports `info.version` 12.1.0 (294 paths). Beebo's fixture is a trimmed copy: `test/fixtures/jellyfin-openapi-12.1.0.json` (source https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json). | api.jellyfin.org |
| `@jellyfin/sdk` 1.0.0 (2026-09-11) targets 12.x, `MINIMUM_VERSION` 10.10.0, and now has a WebSocket service (`?ApiKey=`). | https://github.com/jellyfin/jellyfin-sdk-typescript (CHANGELOG) |
| Jellyfin Web 12.1 pins SDK 1.0.0 and refuses a server older than 10.10.0 ("server update needed"); a changed server `Id` shows "server mismatch". | jellyfin-web `connectionManager.js`, `package.json` |
| Android TV: stable 0.19.10 needs 10.10+, development branch (Kotlin SDK 1.8.12) needs 10.11+, the SDK's own development branch says 12.0+. | jellyfin-androidtv `gradle/libs.versions.toml`, `ServerRepository.kt`; jellyfin-sdk-kotlin `Jellyfin.kt` |
| Findroid 1.0.0 needs 10.11.0+ (0.15.x needs 10.9+). | https://github.com/jarnedemeulemeester/findroid/releases |
| Swiftfin 1.6.1 targets 12.0 (README badge); no version gate was found in its connect code; it decodes strictly (a missing required field breaks decoding). | Swiftfin `ConnectToServerViewModel.swift`, README |
| Streamyfin needs 10.10+ (an unparseable version is accepted). | streamyfin `utils/jellyfin/checkServer.ts` |
| Home Assistant's Jellyfin integration lists a minimum of 10.6.4 and polls `GET /Sessions` every 10 seconds. | https://www.home-assistant.io/integrations/jellyfin/ |

### What changed in Jellyfin 10.9 to 12.1 (and what Beebo does about it)

| Version | Change | Beebo |
| --- | --- | --- |
| 10.9 | `userId` moved from the route to an optional query parameter; `/UserViews`, `/UserItems/*`, `/UserPlayedItems`, `/UserFavoriteItems` replace `/Users/{id}/...`; `POST /QuickConnect/Initiate` replaces GET; trickplay and lyrics endpoints added. | Both old and new forms are served. Initiate answers GET and POST. |
| 10.10 | `MediaSegments` (skip intro/credits data) and `GET /Playlists/{id}`. | Segments implemented from the intro/credits markers; playlists read-only. |
| 10.11 | EF Core database; `EnableLegacyAuthorization`; `/PlayingItems/*` deprecated for `/Sessions/Playing*`; sessions of closed sockets are dropped. | `/Sessions/Playing*` used; both token styles accepted. |
| 12.0 | `/emby` and `/mediabrowser` route prefixes removed; legacy authorization (`api_key`, `X-Emby-Token`, `X-MediaBrowser-Token`, `X-Emby-Authorization`) off by default, only `Authorization: MediaBrowser Token=` and `?ApiKey=` remain; several routes removed (including `GET /QuickConnect/Initiate`); HLS routes hidden from the public description but still served; `GET /Artists` and music-genre calls flagged obsolete but still served. | Beebo keeps the `/emby` prefix and every legacy token form for older apps (no cost), reports version 12.1.0, and serves `/Artists`, `/MusicGenres` and the HLS routes. |
| 12.1 | 47 bug fixes, no API change. | Same. |

Sources: https://github.com/jellyfin/jellyfin/releases (v10.9.0, v10.10.0, v10.11.0, v12.0, v12.1); the archived per-version OpenAPI files at
https://repo.jellyfin.org/files/openapi/stable/ ; `Jellyfin.Api/Controllers/UserLibraryController.cs` and `ItemsController.cs` (master), which keep the
old user-scoped routes marked "kept for backwards compatibility".

---

## 2. Beebo's status per endpoint

`I` implemented with real data. `P` partial (works, with a stated limit). `S` stub (a valid empty or fixed answer so the app does not stop). `M` missing.
All paths are case-insensitive, accept an optional trailing slash and the `/emby` prefix, and every route except discovery/login/images needs a token.
The complete route table is in `electron/jellyfin/router.js`; the conformance test checks the marked ones against the public description.

| Area | Endpoints | Status | Notes |
| --- | --- | --- | --- |
| Discovery | `GET /System/Info/Public`, `/System/Ping`, `/Branding/Configuration`, `/Branding/Css` | I | Reports API level 12.1.0 and `BeeboCompat` (a plain statement that this is Beebo). `ProductName` is "Beebo Entertainment" (see section 5). |
| Discovery | UDP 7359 "Who is JellyfinServer?" auto-discovery | M | Apps that scan the network will not find Beebo by themselves; type the address. |
| Sign in | `POST /Users/AuthenticateByName`, `GET /Users/Public` (empty), `/Users/Me`, `/Users/{id}` | I | Same lockout and alerts as Beebo's website. Two-factor accounts are refused with a message and use an app password. `Client`/`DeviceId` are not required. |
| Sign in | Quick Connect: `Enabled`, `Initiate`, `Connect`, `Authorize`, `AuthenticateWithQuickConnect` | I | Code approved from another signed-in app, or by the owner in Settings > Jellyfin apps. Five minute codes, throttled. |
| Sign in | App passwords (Beebo extension) | I | Per app, per person, made by the owner; the way in for two-factor accounts. Works only on these routes. |
| Sign in | `POST /Sessions/Logout`, `DELETE /Auth/Keys/{own token}` | I | Ends the tracked Beebo session (persists over restarts). |
| Browse | `/UserViews`, `/Users/{id}/Views`, `/Items`, `/Users/{id}/Items`, `/Items/{id}`, `/Items/Latest`, `/UserItems/Resume`, `/Shows/NextUp`, `/Shows/{id}/Seasons`, `/Shows/{id}/Episodes`, `/Genres`, `/Search/Hints`, `/Items/Filters(2)`, `/Items/Counts` | I | Repeated and comma-separated list parameters both work. `Fields=MediaSources` on a short list adds the file tracks. |
| Browse | `/Items/Suggestions`, `/Items/{id}/Similar` (+ Movies/Shows/Albums/Artists forms) | I | Unwatched films and shows; genre-overlap "similar". |
| Browse | Next Up | I | Worked out from the person's own watched marks, honours `enableResumable`, `seriesId`, paging. |
| Browse | Playlists (a person's Beebo playlists) | P | Listed and opened; making or editing them in an app answers 403. |
| Browse | Collections | P | Film collections as BoxSets; `/Collections` write not supported. |
| Browse | `/Persons`, `/Studios`, `/Years`, `/Trailers`, `/Channels`, `/LiveTv/*`, `/Movies/Recommendations`, `/Items/{id}/Ancestors|LocalTrailers|SpecialFeatures|Intros|ThemeMedia|AdditionalParts|Collections` | S | Empty answers. People appear inside item detail. |
| Music | `/Artists`, `/Artists/AlbumArtists`, `/MusicGenres`, `Items?IncludeItemTypes=MusicAlbum|Audio` with `ArtistIds`, `AlbumIds`, `GenreIds`, `InstantMix` (song, album, artist, playlist, genre) | I | Tracks carry the fields music apps need (`AlbumArtists`, `ArtistItems`, `HasLyrics`, `RunTimeTicks`, `Genres`). |
| Music | `/Audio/{id}/universal`, `/Audio/{id}/stream`, `/Items/{id}/File` | I | Direct file or Beebo's own audio conversion. |
| Music | `/Audio/{id}/main.m3u8` (HLS audio), lyrics | M | Finamp's transcoded playback path; lyrics answer 404. |
| Playback | `POST /Items/{id}/PlaybackInfo` | I | Direct play when the app's DeviceProfile allows it, otherwise an HLS `TranscodingUrl`. Honours bitrate, audio and subtitle choice; bedtime and daily limit answer `NotAllowed`. |
| Playback | `GET /Videos/{id}/stream[.ext]` (`static=true`) with Range | I | Through Beebo's own gated file route. |
| Playback | `GET /Videos/{id}/master.m3u8`, `main.m3u8` | I | Starts a Beebo HLS ticket (H.264/AAC, 1080p/720p/480p, whole-file VOD). |
| Playback | Subtitle `Stream.vtt`/`.srt` (with and without start ticks) | I | Text tracks; picture tracks are burnt in. |
| Playback | `GET /Playback/BitrateTest`, `DELETE /Videos/ActiveEncodings` | I / S | Random bytes up to 10 MB; the delete answers 204. |
| Playback | HLS master with a DeviceProfile that asks for fMP4 or HEVC | P | Beebo produces MPEG-TS H.264/AAC only. |
| Progress | `POST /Sessions/Playing`, `/Progress`, `/Stopped`, `/Ping`, `/Capabilities`, `/Full`, `GET /Sessions` | I | Feeds Beebo's own watch history and resume. Sessions list shows the person's own apps and what is playing. |
| Marks | `/UserPlayedItems`, `/UserFavoriteItems`, `/UserItems/{id}/UserData` (GET, POST), legacy `/Users/{id}/...` forms | I | Other apps of the same person are told over the socket. |
| Images | `/Items/{id}/Images/{Primary|Backdrop|Thumb}` | P | Cached posters (one size) and TMDB art redirected to the best size. `Logo`, `Banner`, `Disc` are 404. Tagged images are cacheable for a year. |
| Skip intro | `GET /MediaSegments/{id}` | I | `Intro` and `Outro` from viewer-set and auto-detected markers; `HasSegments` on the media source. |
| Seek preview | `BaseItemDto.Trickplay`, `/Videos/{id}/Trickplay/{width}/{n}.jpg`, `tiles.m3u8` | I | Tile sheets built from Beebo's own preview frames; present once Beebo has made them. |
| Chapters | `BaseItemDto.Chapters` | P | Names and times; chapter thumbnails are not made. |
| Live updates | WebSocket `/socket` | I | `ForceKeepAlive`, `KeepAlive`, `SessionsStart/Stop`, `UserDataChanged`. No remote control (`Play`, `Playstate`, `GeneralCommand`), no `LibraryChanged`. |
| Remote control | `POST /Sessions/{id}/Playing|Command|Message` | M | One app cannot steer another. |
| Admin | `/System/Restart`, `/Users` create/delete, `/Auth/Keys` create, plugins, packages, scheduled tasks, library management | S / M | Refused or empty. Enabling the mode and managing apps is the owner's job in Beebo's Settings. |
| Extras | SyncPlay, Live TV, lyrics, downloads (`403`), Kodi Sync Queue plugin routes | M | Not offered. |

---

## 3. Per client: what it calls, and what Beebo does

Each block lists the calls in the order the app makes them, then the gaps. Sources at the end of the block. "Startup" means connecting, signing in and drawing the home screen.

### Jellyfin Web (official web client, 12.1)
- Version gate: `GET /System/Info/Public` must give `Version` >= 10.10.0 and a stable `Id`. (I)
- Startup: `Info/Public`, `System/Info` (auth check), `Users/{id}`, `Sessions/Capabilities/Full`, WebSocket `/socket?api_key=..&deviceId=..`, `DisplayPreferences/usersettings`, `Playback/BitrateTest` after about six seconds; login page adds `QuickConnect/Enabled`, `Users/Public`, `Branding/Configuration`. (I)
- Home: `UserViews`, `UserItems/Resume`, `Shows/NextUp`, `Items/Latest`; lists via `Items` (and older `Users/{id}/Items`); detail via `Items/{id}` with `Fields=Chapters,MediaSources,Trickplay`, `Shows/{id}/Seasons|Episodes`, `Items/{id}/Similar|LocalTrailers|SpecialFeatures`, `Videos/{id}/AdditionalParts`, `Items/{id}/Collections`, `Audio/{id}/Lyrics`. (I / S)
- Playback: `PlaybackInfo` with its `DeviceProfile` (hls.js, TS or fMP4 profiles); direct play `Videos/{id}/stream.{ext}?Static=true&mediaSourceId&ApiKey&Tag`; transcode `TranscodingUrl` (must contain `PlaySessionId=`); reports `Sessions/Playing`, `/Progress` (at least 10 s apart), `/Stopped`; `DELETE Videos/ActiveEncodings`. (I; fMP4 requests get TS)
- Trickplay tiles with `MediaSourceId`; segments (errors are ignored). (I)
- Gap: Beebo does not serve the web app itself (`/web`); it would have to be hosted elsewhere and pointed at Beebo (CORS is open on these routes). Remote control messages are not sent.
- Sources: https://github.com/jellyfin/jellyfin-web (`src/lib/jellyfin-apiclient/connectionManager.js`, `src/components/playback/playbackmanager.js`, `src/scripts/browserDeviceProfile.js`, `src/apps/legacy/features/playback/utils/mediaSegmentManager.ts`).

### Jellyfin for Android TV
- Version gate at session switch on `Version` (needs a valid GUID `Id`). Branding may be `{}`. (I)
- Login: `AuthenticateByName` or Quick Connect (`Initiate`, poll `Connect`, `AuthenticateWithQuickConnect`); then `GET /Users/Me`; `POST /Sessions/Capabilities` (query parameters); WebSocket with the `Authorization` header only (no `api_key`). (I)
- Home: `UserViews` (no `userId`: the person comes from the token), `UserItems/Resume?mediaTypes=Video`, `Shows/NextUp?enableResumable=false`, `Items/Latest`, with long `Fields` lists including `Trickplay`. (I)
- Detail: `Items/{id}` (no `userId`), `LocalTrailers`, `Shows/{id}/Episodes`, `Similar`. (I / S)
- Playback: `PlaybackInfo` (no `MaxStreamingBitrate` parameter: it is inside the DeviceProfile), `AllowVideoStreamCopy`; direct `Videos/{id}/stream.{ext}?static=true`; a `TranscodingUrl` is required for any non-direct choice; `DELETE Videos/ActiveEncodings`. (I)
- Reports: `Sessions/Playing`, `/Progress`, `/Stopped`; refreshes Resume and Next Up after stop. (I)
- Media segments (errors ignored). No trickplay use found. (I)
- Risk: it discovers servers through the Kotlin SDK's recommended-server scoring; see section 5 about the product-name check.
- Sources: https://github.com/jellyfin/jellyfin-androidtv (`auth/repository/ServerRepository.kt`, `SessionRepository.kt`, `data/eventhandling/SocketHandler.kt`, `ui/playback/PlaybackManager.kt`, `util/profile/deviceProfile.kt`).

### Swiftfin (iOS and Apple TV)
- Connect: `GET /System/Info/Public` (needs `Id`, `ServerName`); sign-in view calls `Users/Public`, `Branding/Configuration`, `QuickConnect/Enabled`. (I)
- Login: `AuthenticateByName` or Quick Connect; Quick Connect approval from a signed-in device is `POST QuickConnect/Authorize?code=&userId=`. Home: `UserViews`, `UserItems/Resume`, `Shows/NextUp`, `Items/Latest`, with `Fields=MediaSources,ParentId`. (I)
- Player: `GET Items/{id}?userId=` (full item), `PlaybackInfo` (`AutoOpenLiveStream`, `DeviceProfile`, `MaxStreamingBitrate`, stream indexes); needs `PlaySessionId`; picks the media source by `ETag`, then `Id`; direct play `Videos/{id}/stream?static=true&tag&playSessionId&mediaSourceId` (no file extension); `TranscodingUrl` for HLS. (I)
- Trickplay `Videos/{id}/Trickplay/{width}/{n}.jpg` without `MediaSourceId`. Socket `?api_key=&deviceId=` plus header, answers must come or it reconnects in a loop. (I)
- Segments: not used. Strict decoding: emit every required field (the conformance test checks types, enums and required fields against the public description).
- Sources: https://github.com/jellyfin/Swiftfin (`Shared/ViewModels/ConnectToServerViewModel.swift`, `MediaPlayerItem+Build.swift`, `MediaProgressObserver.swift`), https://github.com/jellyfin/jellyfin-sdk-swift (`JellyfinSocket.swift`).

### Findroid (Android)
- Setup uses the Kotlin SDK's discovery: `GET /System/Info/Public` scored for `ProductName`, version (needs 10.11+ for 1.0), speed (over 1.5 s is "slow"). Then `QuickConnect/Enabled`, `Branding/Configuration`, `AuthenticateByName` or Quick Connect, `Users/Me`, `Sessions/Capabilities`, `Devices/Options`. (I)
- Browse: `UserViews`, `Items`, `UserItems/Resume`, `Items/Latest`, `Shows/NextUp?enableResumable=false`, `Seasons`, `Episodes`, `Items/Suggestions`, favourite and played marks. Images built by hand with lower-case `/items/{id}/Images/...` (Beebo matches case-insensitively). (I)
- Playback is direct play only (an empty DeviceProfile named "Direct play all"): `PlaybackInfo`, then `Videos/{id}/stream?static=true&mediaSourceId=`; subtitles external SRT/ASS. Empty direct-play profiles are treated as "anything Beebo can direct play". Trickplay tiles and `MediaSegments`. (I)
- Blocker risk: the product-name check (section 5). Files Beebo cannot direct-play (unusual containers) have no fallback in Findroid.
- Sources: https://github.com/jarnedemeulemeester/findroid (`data/.../JellyfinRepositoryImpl.kt`, `setup/.../SetupRepositoryImpl.kt`, releases), https://github.com/jellyfin/jellyfin-sdk-kotlin (`RecommendedServerDiscovery.kt`).

### Streamyfin (iOS and Android, React Native)
- Startup: `GET /System/Info/Public` (`Version`, `ServerName`; probes other schemes and ports if not 2xx), background `Users/Me`, `AuthenticateByName` or Quick Connect. (I) UDP discovery on 7359 is not answered (M).
- Playback: `PlaybackInfo` with `userId`, `deviceProfile`, `startTimeTicks`, stream indexes, `maxStreamingBitrate`; throws if `MediaSources[0]` is missing; plays `TranscodingUrl` (relative to the server) or `Videos/{id}/stream?static=true&container=&mediaSourceId=&ApiKey=`. (I)
- Reports with `PlaySessionId`, `PlayMethod`; manual played marks. (I)
- Socket `/socket?ApiKey=&deviceId=`, `KeepAlive` every 30 s, reacts to `LibraryChanged` and `UserDataChanged`. (I / P: `LibraryChanged` is not sent)
- Segments (Intro, Outro, Recap, Commercial, Preview), trickplay from the item metadata. (I) Its own extra plugin calls (`/Streamyfin/...`) are optional and answer 404. Playlists it may create answer 403.
- Sources: https://github.com/streamyfin/streamyfin (`utils/jellyfin/checkServer.ts`, `providers/JellyfinProvider.tsx`, `utils/jellyfin/media/getStreamUrl.ts`, `providers/WebSocketProvider.tsx`).

### Infuse (Apple TV, iPhone, iPad, Mac; closed source)
- Nothing here is confirmed at request level: Firecore documents features only. Direct server login (address, username, password); "Direct Mode" and "Library Mode"; "Library Mode" is recommended with Firecore's InfuseSync plugin. Direct play before Infuse 8.5, user-chosen transcoding from 8.5; 8.5.2 supports Jellyfin 12. (documentation)
- Known quirks to be safe against: some clients omit `Client`/`DeviceId` in the Authorization header (Beebo accepts that); one report of non-administrators failing to sign in until an administrator had (Beebo asks no first-connect call for an administrator).
- Likely calls (INFERRED): `Info/Public`, `AuthenticateByName`, bulk `Items` with big `Fields` lists, `Items/Latest`, `UserItems/Resume`, `Shows/*`, `PlaybackInfo`, `Videos/{id}/stream?static=true` with Range, `Sessions/Playing*`, `UserPlayedItems`, images.
- Gap: InfuseSync's own routes are unknown and not offered, so Library Mode's incremental sync is not expected to work; Direct Mode is.
- Sources: https://support.firecore.com/hc/en-us/articles/360006462093-Streaming-from-Plex-Emby-and-Jellyfin , https://firecore.com/blog/infuse-85-smarter-streaming , https://community.firecore.com/t/jellyfin-not-reporting-transcoding-when-selected-in-infuse/60456 , https://github.com/jellyfin/jellyfin/issues/15730 , https://github.com/jellyfin/jellyfin/issues/11197 .

### Kodi: JellyCon (browse add-on) and Jellyfin for Kodi (sync add-on)
- JellyCon (https://github.com/jellyfin/jellycon): `AuthenticateByName`, `Sessions/Capabilities/Full`, `GET /playback/bitratetest`, browse through `Users/{id}/Views|Items|Items/Latest|Shows/NextUp` (older forms, served), `PlaybackInfo?MaxStreamingBitrate=`, direct `Videos/{id}/stream?static=true`, its own `Videos/{id}/master.m3u8?VideoCodec=&VideoBitrate=&MaxWidth=&AudioCodec=&TranscodingMaxAudioChannels=` (Beebo reads the bitrate and height parameters; width is ignored), external subtitles `.../Subtitles/{i}/Stream.srt`, reports, socket `/socket` with `KeepAlive` every 30 s. (I / P)
- Jellyfin for Kodi (https://github.com/jellyfin/jellyfin-kodi) syncs everything into Kodi's database and expects the Kodi Sync Queue server plugin (`Jellyfin.Plugin.KodiSyncQueue/...`) plus `System/Configuration`. Beebo has neither: **not expected to work.**

### Finamp, Gelly (music) and Home Assistant
- Finamp (https://github.com/jmshrv/finamp, redesign branch): keeps using the older `/Users/{id}/Views|Items|Items/Latest|FavoriteItems` (served), `Artists`, `Artists/AlbumArtists`, `Genres`, `Playlists/{id}/Items`, `Items/{id}/InstantMix`, `Items/{id}/File?ApiKey=` (direct), `Audio/{id}/universal`, and `Audio/{id}/main.m3u8` for transcoding (missing). Sessions reports must answer with an empty body (204). (I / P)
- Gelly (https://github.com/Fingel/gelly): loads every `Audio` item (paged) and silently skips a track missing `Name`, `Id`, `RunTimeTicks`, `AlbumArtists`, `ArtistItems`, `UserData.PlayCount`, `HasLyrics` or `Genres`: all are present. Lower-case paths and trailing slashes are used (matched). Creating playlists from Gelly answers 403. (I / P)
- Home Assistant (https://www.home-assistant.io/integrations/jellyfin/): polls `GET /Sessions?ControllableByUserId=` every 10 seconds and reads `NowPlayingItem` and `PlayState` (Beebo fills both while an app reports playback); signs in with `AuthenticateByName` then `DisplayPreferences/usersettings`. It only sees the signed-in person's own apps, on purpose. Remote control (`POST /Sessions/{id}/Playing|Command`) is not offered. (P)

---

## 4. Website-ready compatibility table

Status words: **Expected to work** (the calls the app makes are implemented and checked at protocol level), **Partial** (works with a stated limit),
**Not expected to work** (a needed piece is missing). **Every row is UNTESTED with the real app.** Tick a row to "Tested" only after someone runs the
app on a real device and writes down the date, app version and Beebo version.

Beebo's own label for this feature is **Beta**.

| App | Platform | What we expect | Real-app test | Known limits |
| --- | --- | --- | --- | --- |
| Swiftfin | iPhone, iPad, Apple TV | Expected to work | UNTESTED | Remote control from other apps is not offered. |
| Infuse | Apple TV, iPhone, iPad, Mac | Expected to work in Direct Mode | UNTESTED | Closed source, so nothing beyond documentation and public bug reports is known. Library Mode with the InfuseSync plugin is not expected to work. |
| Streamyfin | iPhone, Android | Expected to work | UNTESTED | Creating playlists from the app is refused; live library-changed nudges are not sent. |
| Jellyfin for Android TV | Android TV, Fire TV | Partial | UNTESTED | Setup may refuse a server whose product name is not Jellyfin's (section 5). |
| Findroid | Android | Partial | UNTESTED | The same product-name check is confirmed in its setup library; files that cannot be direct-played have no fallback. |
| Jellyfin Web | Browsers | Partial | UNTESTED | Beebo does not host the web app; it must be hosted elsewhere and pointed at Beebo. |
| JellyCon (Kodi) | Kodi | Partial | UNTESTED | Transcoded playback uses the app's own URL; width limits are ignored. |
| Jellyfin for Kodi (sync add-on) | Kodi | Not expected to work | UNTESTED | Needs the Kodi Sync Queue server plugin. |
| Finamp | iPhone, Android | Partial | UNTESTED | Direct music playback expected; its transcoded (HLS audio) path is missing. |
| Gelly | Linux | Expected to work | UNTESTED | Playlist creation refused. |
| Home Assistant | Home automation | Partial | UNTESTED | Shows what is playing; cannot control playback. |
| Official Jellyfin TypeScript SDK client (a test tool, not an app) | scripts | Works | Tested (automated: sign-in, browse, playback info, ranged stream, reports, search, subtitles, trickplay, segments, music, live socket) | Proves the wire format only. |

Safe public sentence: "Beebo answers the Jellyfin API so many Jellyfin apps can connect. It is in beta and has not been tested with every app; see the table."

---

## 5. Decisions the owner has to make

1. **Product name in the handshake.** The Kotlin SDK's server discovery (used by Findroid, and very likely by Android TV) flags a server whose `ProductName` is not "Jellyfin Server" as "not a Jellyfin server" (`RecommendedServerDiscovery.kt`; confirmed for Findroid's setup, UNTESTED for Android TV). Beebo reports "Beebo Entertainment" and says so in a `BeeboCompat` object. Changing that string to Jellyfin's product name is a single constant (`PRODUCT_NAME` in `electron/jellyfin/constants.js`), but it would present Beebo as Jellyfin's product in a protocol field. This has **not** been done: it needs the owner's decision (and a lawyer's view of nominative use), and a real test to see which apps actually refuse.
2. **UDP auto-discovery on port 7359.** Would let Infuse, Swiftfin, Findroid, Streamyfin and Kodi find Beebo without typing an address. It opens a LAN listener; it is not built. Design: a separate opt-in switch, answers only `Who is JellyfinServer?` with `{Id, Name, Address}`, same rate limits as the HTTP side.
3. **Reported version.** Beebo reports 12.1.0. If a real app shows unexpected behaviour tied to that number, lowering it is one constant (`COMPAT_API_VERSION`), at the cost of failing newer apps' minimum-version checks.

---

## 6. How this is tested

| Test | What it proves | Run |
| --- | --- | --- |
| `test/jellyfin-conformance.test.js` | 80 calls (across 60 or so distinct routes) on a real server, every JSON answer validated against the public OpenAPI description (types, enums, uuid and date-time formats, required fields, misspelt or unknown properties). Found and fixed real deviations (a misspelt `ReadAtNativeFramerate`, `SearchHints[].MediaType`, retired session fields, `/Items/Suggestions` swallowed by `/Items/{id}`). | `node --test test/jellyfin-conformance.test.js` |
| `test/jellyfin-sdk-e2e.test.js` | The official typed SDK signs in, browses, asks for playback info, reads a file range, reports progress, searches, gets subtitles, trickplay sheets and segments, browses music, and receives a live `Sessions` message over the socket. | `node tools/jellyfin-sdk-setup.js` once (installs the SDK in a temp folder, never in the repo), then `node --test test/jellyfin-sdk-e2e.test.js` |
| `test/jellyfin-hardening.test.js` | WebSocket protocol (masking, fragments, limits, keep-alive, pushes), app passwords and two-factor refusal, Quick Connect approval, tracked sessions and sign-out, lenient headers, Next Up, Suggestions, Similar, `DateCreated`/ETag stability, segments, trickplay tiles, music-app fields, the self-check. | `node --test test/jellyfin-hardening.test.js` |
| `test/jellyfin-settings-ui.test.js` | The Settings panel model and view, the IPC doorway and its wiring. | `node --test test/jellyfin-settings-ui.test.js` |
| existing `test/jellyfin-compat-*.test.js` | Ids, headers, route table (no Beebo path is ever claimed), DeviceProfile, HLS, parental controls, restricted profiles. | as before |

To refresh the description: download the newest `jellyfin-openapi-stable.json`, run `node tools/jellyfin-openapi-trim.js <file> test/fixtures/jellyfin-openapi-<version>.json`,
point `SPEC_FILE` in the conformance test at it, and fix whatever it reports.

---

## 7. Not done yet (deferred, in order of value)

1. UDP 7359 auto-discovery (needs the owner's opt-in decision).
2. `LibraryChanged` push (apps refresh their home rows when the library changes), and remote-control messages (deliberately not offered).
3. Playlist and collection editing from apps (Finamp, Gelly, Streamyfin); Beebo's playlist API can already do it.
4. HLS for audio (`/Audio/{id}/main.m3u8`) and fMP4/HEVC transcoding profiles.
5. Chapter thumbnails, `Logo`/`Banner` images, image resizing for cached posters.
6. `/Persons`, `/Studios` as real lists; `Similar` by cast.
7. A real capture of each app (mitmproxy against a real Jellyfin, then against Beebo) to replace the derived call lists above, starting with Infuse.
8. Per-person app passwords on the website (today the owner makes them in the desktop app).
9. Translating the Settings panel (it is plain English like the rest of the older settings blocks).
