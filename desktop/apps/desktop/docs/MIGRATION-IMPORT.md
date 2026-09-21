# Migration importer ("Switch to Beebo")

Brings a person's data from Plex, Jellyfin, Emby, Kodi and Letterboxd into Beebo, per person, for the
titles that exist in this library. Owner only. Nothing is written until the owner chooses Import, and
every import can be undone.

## What is imported

| Data | Where it lands in Beebo | Sources |
| --- | --- | --- |
| Watched marks (with the date really watched) | `watchedState` (`source: "import:<product>"`) | all |
| Resume points | `watchHistory` rows (Continue Watching), placed before the existing rows | Plex, Jellyfin, Emby, Kodi, Plex csv |
| Star ratings (stored 0.5-10) | `userRatings` (new, `electron/userRatings.js`) | Plex, Jellyfin, Emby, Kodi (`<userrating>`), Letterboxd |
| Favourites | `libraryFlags[user]["movie:<id>" / "tv:<id>"].favorite` | Jellyfin, Emby, Letterboxd (likes) |
| Watchlist | `watchlist[user]` (films, episodes, whole shows) | Plex Watchlist, Plex csv, Letterboxd |
| Playlists / lists | manual playlists owned by the mapped person (`playlists.js`) | Plex, Jellyfin, Emby, Letterboxd lists |
| Kodi `.nfo` details: title, year, ids, plot, ratings, actors, artwork paths, genres, tags | `importedMetadata["movie:<file>"]` | Kodi |

Plex has no favourites; Jellyfin/Emby favourite *shows* and Kodi favourites are not imported (Beebo
favourites are per film/episode). A show-level rating is stored against the show (`show:<showKey>`).

## The flow

`read (adapter) -> match -> review -> dry run -> import -> summary / undo`

* **Read.** Adapters in `electron/migration/` turn each product into one bundle shape
  (`migration/model.js`): people, items with provider ids and per-person state, lists, warnings.
  * `kodi.js`: `.nfo` (movie / tvshow / episodedetails), a bare-URL `.nfo`, Kodi's `videodb.xml`;
    from a folder the desktop file dialog chose, from Beebo's own library folders, or uploaded files.
  * `letterboxd.js`: the export `.zip` (watched, diary, ratings, watchlist, likes/films, lists/*) or loose csv files.
  * `jellyfin.js` (Jellyfin and Emby): HTTP API with an API key; per chosen person: Series, Movies,
    Episodes (paged, with `UserData`), playlists.
  * `plex.js`: a server address + Plex token (per token = one person; plus the account Watchlist from
    plex.tv's discovery host), or a watch-history csv (Tautulli export or any sheet with title / year /
    date / rating / ... columns, see `COLS` in the file).
* **Match** (`migration/match.js`). Provider ids (tmdb, imdb, tvdb) first, then the source's file name
  against library file names, then title + year. Shows match by id or name, then season + episode.
  Only *matched* items are applied unattended; *ambiguous* and *unmatched* wait in the review screen
  and are skipped unless the person picks a title (search the library, choose a show then an episode).
  An id conflict beats a name match (a remake is not the original). Titles that have an IMDb or TheTVDB
  id but no TMDB id, and did not match, are looked up once on TMDB (owner's TMDB key, at most 300 lookups).
* **Dry run / import** (`migrationImport.js`). The plan is computed from the reviewed matches and what
  each person already has. Dry run returns the plan's numbers and writes nothing.

## Merge rules

Merge, never overwrite: a title already watched here (any version of the film), already rated,
already a favourite, already on the watchlist, or with its own progress, is left exactly as it is.
Ratings can be told to overwrite. Nothing is ever un-marked. Resume points skip the first 30 seconds and
the last 5% (the same lines `history.js` draws) and need a known duration. Watch history is capped at
300 rows by the store, so the import takes only what fits (newest first) and never trims real history.

## Undo

A real import first writes a journal to `<store folder>/migration-undo/imp_*.json` (safeJson: atomic,
with a `.bak` last-good copy) holding the values it is about to change, then applies every store write
in one synchronous step, then completes the journal (status `applied`) with the before/after of every
change. If a write throws part-way, what was written is reverted at once and the journal says `failed`.
Undo puts each value back only while it still equals what the import wrote; anything the person
changed afterwards is left alone and counted (`changedSince`). The newest 20 journals are kept. A
journal that never completed (a crash mid-import) is listed as `interrupted` and cannot be undone
automatically.

## Contract

`migrationApi.js` is transport-independent. The desktop window calls it over IPC
(`window.beeboentertainment.migrationCall(method, path, body, query)`, main.js `migration:call`,
always as the first approved admin); the same routes are at `/api/admin/migration/...` behind the
admin API's TLS + `isAdmin` gates (no "folder" mode there, bodies over 200 MB are refused before being read).

```
GET  sources                    POST connect {source, baseUrl, apiKey|token, insecureTls?}
POST sessions {source, mode, files[{name, base64|data}] | grantId | baseUrl+apiKey+userIds | baseUrl+token}
GET  sessions/:id               (poll while reading / matching)
GET  sessions/:id/preview?filter=review|matched|notInLibrary|decided|all&type=&q=&offset=&limit=
GET  sessions/:id/search?q=&type=   or   ?showKey=
POST sessions/:id/configure {userMap, options, decisions}
POST sessions/:id/import {dryRun}      DELETE sessions/:id
GET  imports                    POST imports/:id/undo
```

## Security

* Owner only (`403 owner_only` for everyone else); sessions belong to the person who started them,
  expire after 2 idle hours, at most 4 per person.
* **Credentials** (API key / Plex token) are validated as header-safe tokens, sent only in request
  headers (never in an address), used for that one read, wiped from the request object, and are not on
  the session, in the journal, the store, a log line (`logRedact` is applied to every log line and only
  codes and counts are logged) or an error message (short codes such as `http_401`, `timeout`).
* **SSRF** (`migration/safeFetch.js`): http(s) only, no `user:pass@`, no query in a pasted address;
  the name is resolved once, every answer is checked, and the socket connects to the address that was
  checked (no DNS rebinding); link-local (cloud metadata), 0.0.0.0, multicast and broadcast are refused
  always; plex.tv is public-only; redirects are refused (the key never follows one); size and time limits.
  LAN addresses are allowed on purpose (that is where a home Plex/Jellyfin lives). "Self-signed
  certificate" is honoured only for private addresses and only when ticked.
* **Untrusted files**: XML (`migration/xml.js`) refuses any DOCTYPE/ENTITY (billion laughs, XXE), decodes only
  the 5 named entities and numeric references, and caps size/depth/nodes; ZIP (`migration/zip.js`) is read
  in memory only (nothing extracted to disk, so no zip-slip), skips `..` / absolute / drive-letter / NUL
  names, and caps entry count, per-entry and total inflated size, compression ratio, and checks CRC;
  CSV (`migration/csv.js`) caps size, rows and field length; `.nfo` artwork values are kept as text only
  (an http(s) address or a relative path without `..`); the Kodi folder walk does not follow links and
  has file-count, depth and byte caps. Kodi folders come from a short-lived grant made by the app's own
  file dialog, never from a path the page supplies. Journal ids are validated (`imp_[a-z0-9]+`) before they touch a path.

## Tests

`test/migration-parsers.test.js`, `migration-servers.test.js` (mock Jellyfin/Emby/Plex servers on
127.0.0.1, SSRF), `migration-match.test.js`, `migration-import.test.js` (end to end, undo, rollback),
`migration-api.test.js` (contract + the real stream server), `migration-ui.test.js`. Fixtures are in
`test/fixtures/migration/`, helpers in `test/helpers/migrationFixtures.js`.

## Not done yet

* Plex PIN sign-in (plex.tv/link): the token is pasted for now. Other Plex users need their own token.
* Showing the imported ratings and `.nfo` details in the app's own screens (they are stored and backed up;
  nothing displays them yet), and using `.nfo` ids to fix library matches.
* Kodi favourites / playlists (`.m3u`, `.xsp`), Trakt, Emby/Jellyfin collections and Kodi "sets" as lists.
* Undo of an `interrupted` journal (a crash mid-import).
