# Performance on a big library

Goal: Beebo stays fast and light with 1,000+ movies, 1,300+ shows (40,000 episode files), 50,000 music tracks and
100,000 photos, and on an old, low-end PC. Competing servers get complaints about slowness at that size; this is the
measured state of Beebo, what was changed, what was left, and how to re-measure.

Everything here is reproducible with the scripts in `test/perf/` (no Electron needed).

## Tools (`test/perf/`)

| Script | What it does |
|---|---|
| `gen-synthetic-library.js` | Writes a synthetic library: `Movies/Title (Year).mp4`, `TV Shows/Show (Year)/Season 01/Show - S01E01.mp4`, `Music/Artist/Album/NN - Track.mp3` (valid ID3v2 + MPEG frames), `Photos/YYYY/MM/IMG_n.jpg` (valid JPEG with an EXIF block, some with GPS) and a fake TMDB cache (manifest, tv-manifest, credits, collections, poster files) so every title is "matched" and nothing touches the network. Profiles: `big` (1,000 / 1,300 shows / 40,000 episodes / 50,000 / 100,000), `small`, `tiny`. Seeded, deterministic. |
| `bench-server.js` | One real stream server on that library, a real `conf`/electron-store `config.json` (so every `store.get` re-parses the file like the packaged app) wrapped in `secretSettings` like `main.js`, real HTTP. Runs each measurement in a fresh child process and reports the median of N. Counts `store.get` calls and their cost per request. |
| `bench-micro.js` | `store.get` at 20 KB / 200 KB / 1 MB, TMDB manifest write/parse at 1k/2k/5k titles, HLS prune, photo EXIF read. |
| `bench-scanner.js` | The intro/credits scanner's own bookkeeping over N files with every ffmpeg call faked. |
| `require-profile.js` | Start-up: which module loads cost the most. |
| `cpuprof-top.js` | Top functions of a `node --cpu-prof` profile. |
| `renderer-grid.html` + `static-server.js` | The poster grid (real `styles.css`, same card structure as `Movies.jsx`) with N cards in a browser: build, layout, paint, scroll frames. |
| `compare.js` | Before/after table from two `bench-server.js --json` files. |

```
node test/perf/gen-synthetic-library.js --out D:\bench\lib          # ~90 s, ~190,000 tiny files
node test/perf/bench-server.js --lib D:\bench\lib --only movies,tv --reps 5 --json after.json
node test/perf/compare.js before.json after.json
```

What is real and what is not: video files are 64-byte placeholders, enough for every scan, index and list route
but not playable, so ffprobe/ffmpeg/HLS/trickplay costs need real media (use `--real-video`). MP3 and JPEG files are
structurally valid. Poster images are 4-byte files (the "poster is cached locally" path is exercised, the pixels are not).

## Methodology and caveats

* Machine: Intel i5-8400 (6 cores, 2.8 GHz), 31.9 GB RAM, Windows 10 (19045), Node 24.19 (Electron 31 ships Node 20, so
  absolute numbers differ a little), SSD. This is a fast PC: an old dual-core with a hard disk will be several times
  slower on CPU-bound and much slower on I/O-bound items; the ratios are what carry over.
* Server numbers are the **median of 5 fresh processes**; each route is called once (the "first" response) and then
  20 times (p50/p95 over those calls). The OS file cache is warm after the first pass; a truly cold disk was not measured.
  The very first run after the generator wrote the library is reported separately where it matters.
* The machine was shared with other agents' Node processes (load average not reported by Windows; every number was taken
  with nothing else of mine running). The "before" build is a byte-for-byte copy of the code at the start of this work
  (`git archive HEAD`), run with the same scripts against the same library.
* All requests use `Accept-Encoding: identity` unless the row says gzip, so sizes and times are the plain-JSON cost.
* Micro-benchmarks are the median of 5 repetitions of many iterations each.

## Results: 1,000 movies, 1,300 shows / 40,000 episodes (server, median of 5 fresh processes)

Numbers are milliseconds. "before" is the code at the start of this work, "after" the code in this branch.

| Route | response bytes | p50 before | p50 after | p95 before | p95 after | `store.get` per request |
|---|---:|---:|---:|---:|---:|---:|
| `GET /api/ping` | 53 | 0.49 | 0.70 | 1.53 | 1.96 | 0 |
| `GET /api/movies` (1,000 films) | 779,028 | 226.8 | **48.8** | 257.6 | 94.6 | 5.1 |
| `GET /api/movies?sort=year` | 779,028 | 222.2 | **50.0** | 291.3 | 83.0 | 5 |
| `GET /api/movies?q=the` | 367,310 | 211.6 | **36.0** | 234.7 | 69.1 | 5 |
| `GET /api/recently-added` | 4,084 | 490.2 | **118.9** | 569.0 | 137.4 | 5 |
| `GET /api/continue` | 22 | 33.6 | 22.6 | 40.2 | 47.7 | 6 |
| `GET /api/recommended` | 34 | 19.7 | **2.9** | 23.7 | 8.6 | 6 |
| `GET /api/library-status` | 44 | 16.7 | **1.0** | 19.3 | 5.9 | 5 |
| `GET /watch?id=` (web player page, 55.9 KB) | 55,904 | 83.1 | **22.4** | 97.0 | 29.5 | 16 |
| `GET /api/tvshows` (1,300 shows, 40,000 episodes) | 282,723 | 634.7 | **84.8** | **5,709** | **143** | 6 |
| `GET /api/tvshows/<id>/episodes` (404 here: id from the list is a key) | 32 | 163.7 | 57.2 | 202.4 | 79.0 | 4 |

A last re-run after merging `main` (3 fresh processes, machine quieter, main added 2 more settings reads per request and
version grouping to the movie list): `/api/movies` p50 39 ms, `/api/recently-added` 80, `/api/tvshows` 52 (p95 59), `/watch` 16,
`/api/library-status` 0.5; the "before" column is unchanged. Treat the run-to-run spread on this shared machine as roughly +/-30%.

The first ever request after boot pays the first walk of the library: `/api/recently-added` 5,704 ms and `/api/tvshows`
650 ms before and after (unchanged: the walk itself is the same code, on the worker thread; only re-walks were removed).

Reading the table:

* `/api/tvshows` had a p95 of 5.7 s. That was not the route: after every 15 seconds of quiet the library cache was
  declared old, and the *next request waited for a fresh walk of 40,000 files* on the worker thread (5.7 s here, an SSD).
  A walk that no folder watcher had reported a change in is now trusted for 2 minutes and, beyond that, served while a new
  walk runs in the background (`catalog.js`). A change a watcher does report still waits for a fresh walk, exactly as before.
* `store.get/req` did not change (the server still asks the settings store 5 to 16 times per request); each ask went from
  re-reading and re-parsing the whole `config.json` (about 3.5 ms averaged over the run at 260 KB, and 0.9 to 11 ms
  in isolation depending on the disk's mood) to a lookup in memory (0.2 ms averaged, which is mostly the
  re-read after each write; a repeat get is under a microsecond).
* `/api/recently-added` and the TV list are dominated by walking 40,000 episodes in JavaScript; they are the remaining
  O(number of files) routes (see "Left alone").
* `/api/ping` is the floor for an authenticated-less request through the whole handler: 0.5 to 0.7 ms.

| Whole-process metric | before | after |
|---|---:|---:|
| boot: `startStreamServer()` call to answering `/api/ping` | 105 ms | 103 ms |
| `require('streamServer.js')` in a fresh Node (`startup.js`, min of 15 runs, machine busy) | 260 to 410 ms | 190 to 210 ms (of which lazy `nodemailer` is about 45 ms) |
| RSS after the whole route sweep (median of 5; per-run range 358 to 619 MB, GC timing) | 530 MB | 557 MB (no change beyond noise) |
| JS heap after a forced GC | 33 MB | 48 MB (the file-name and stat memos, about 15 MB at 40,000 episodes) |
| idle CPU, 15 s after the last request, one core = 100% | 1.25% | 0.11% |
| idle event-loop delay p99 | 30 ms | 25 ms |
| `store.get` calls in the run / total time in them | 998 / 3,499 ms | 998 / 211 ms |
| `store.get` mean | 3.51 ms | 0.21 ms |
| `store.set` mean (writes the whole file; unchanged, see "Left alone") | 14.5 ms | 17.4 ms |

Photos and Music (50,000 tracks, 100,000 photos; one process each because the very first scan alone is minutes):

| | before | after |
|---|---:|---:|
| `GET /api/photos/timeline?limit=200` p50 / p95 (204 `store.get` per request) | 1,235 / 3,312 | 36 / 48 |
| `.../timeline?limit=200&tokens=1` p50 / p95 | 2,110 / 4,690 | 47 / 272 |
| `store.get` time inside one photo-timeline request | 1,849 | 0.4 |
| `GET /api/music/tracks?limit=200` p50 | 13.2 | 3.9 |
| `GET /api/music/albums` p50 (927 KB) | 27.3 | 13.2 |
| `GET /api/music/tracks` (all 50,000, 26.2 MB) p50 | 475 | 373 |
| music: first scan, tags of 50,000 files read | 171 s | (unchanged; warm rescan with the saved index: 12.8 s) |
| photos: first timeline request (100,000 files indexed) | 99 s | (unchanged; see EXIF row below) |

Wire size with `Accept-Encoding: gzip` (new; clients that do not ask get the old bytes):

| Response | plain | gzip | ratio |
|---|---:|---:|---:|
| `/api/movies` (1,000 films) | 779,028 | 104,790 | 7.4x |
| `/api/tvshows` (1,300 shows) | 282,723 | 30,813 | 9.2x |
| `/api/music/albums` | 927,408 | 104,015 | 8.9x |
| `/api/music/tracks` (all) | 26,221,936 | 2,218,626 | 11.8x |

Micro-benchmarks (median of 5, ms per operation):

| | before | after |
|---|---:|---:|
| `store.get('streamPort')`, 20 KB config | 1.6 to 7.0 | < 0.001 |
| `store.get('streamPort')`, 200 KB config | 3.5 to 4.5 | < 0.001 |
| `store.get('streamPort')`, 1 MB config | 4.5 to 11.5 | < 0.001 |
| `store.get('sessionSecret')` (two reads through `secretSettings`), 1 MB | 12 to 33 | < 0.001 |
| photo EXIF read, one 3 MB JPEG (file cache warm) | 10.5 | 1.2 |
| intro scanner bookkeeping, pass over 2,000 files | 3,985 | 53 |
| ... 5,000 files | 25,444 | 130 |
| ... 10,000 files | 111,917 | 241 |
| ... 40,000 files | (estimated 30 minutes; quadratic) | 899 |
| HLS `prune()` per segment request, 60 / 2,000 files in the folder | 0.145 / 0.13 | (unchanged, see "Left alone") |
| TMDB manifest `writeJson`, 1,000 / 2,000 / 5,000 titles | 15 / 22 / 49 | (unchanged) |

Renderer (Chromium in the browser pane, real `styles.css`, 2,000 poster cards = 34,000 DOM nodes, 1400x900, median of 4):

| | content-visibility off | on (as shipped) |
|---|---:|---:|
| build DOM | 96 | 96 |
| first style + layout | 346 | 29 |
| first paint | 162 | 67 |
| **total to first paint** | **650** | **194** |
| scroll, 150 px per frame: avg / max frame | 17.5 / 34 | 19.0 / 54 |
| dropped frames (> 34 ms) of 200 | 0 | 2 |

Renderer JavaScript parsed at start-up: 1,009 KB (284 KB gzip) in one file before; 206 KB (67 KB gzip) now, with each
screen a separate chunk loaded the first time its tab is opened (`Movies` 63 KB, `TVShows` 52 KB, `Settings` 223 KB, `Photos` 170 KB).

## Top hot spots, ranked by cost x frequency (before the fixes)

Frequency assumes a busy household: two screens being browsed (a list request every ~30 s each, 240 an hour), the
desktop window open, a 40,000-file library with the automatic scanner still working through it. Cost is measured, from the runs above.

| # | Hot spot | Cost each | How often | About per hour | Status |
|---|---|---:|---|---:|---|
| 1 | Intro scanner: `progressCount` re-run after every episode (`introDetectJob.js`), on the main thread | 3.99 s / 2,000 files, 25 s / 5,000, 112 s / 10,000 (quadratic; about 30 min for 40,000, before a single ffmpeg call) | each pass until the library is scanned; passes every 30 min | the whole scan window, in 50 ms slices that stall every stream | **fixed** (899 ms for 40,000) |
| 2 | Library re-walk once the cache is 15 s old (`catalog.js`): the next request waits for a walk of every file | 5.7 s p95 request, ~5.7 s worker CPU (40,000 `stat` calls) | any list request after 15 s of quiet, up to 240 an hour | up to 23 min of walking an hour | **fixed** (trusted 2 min while no watcher fires, then served stale while re-walking) |
| 3 | `store.get` re-reads and re-parses all of `config.json` (`conf`; 79 calls in `main.js`, 75 in `streamServer.js`) | 0.9 to 11 ms per call at 260 KB to 750 KB, 3.5 ms mean in the sweep | 5 per list request, 16 per player page, **204 per photo timeline page (1.85 s)** | 4 to 13 s of parsing an hour on lists; 1.85 s each photo page | **fixed** (< 0.001 ms; 0.21 ms mean including refills after writes) |
| 4 | Show map: every file name parsed with regexes (`buildShowMap`) on each TV request | ~70 ms at 40,000 | every `/api/tvshows`, `recently-added`, `episodes`, `upnext` | 1 to 2 min | **fixed** (memoised per file) |
| 5 | Per-item disk calls and path work in list routes: `existsSync` per poster, `statSync` per film for the quality badge, `path.join` + `resolve` per episode (twice) | ~35 ms + ~14 ms per 1,000 films; ~110 to 250 ms at 40,000 episodes | every `/api/movies`, `/api/tvshows`, `/api/recently-added` | 1 to 2 min | **fixed** (one folder listing per request; stat remembered 60 s; prefix join) |
| 6 | `parseMovieTitle` regexes per film per request | ~25 ms per 1,000 films | every `/api/movies`, `recently-added`, `library` | ~10 s | **fixed** (memoised) |
| 7 | Photo scan reads 512 KB of every photo for its Exif | 10.5 ms / 3 MB photo (cache warm) = 17 min for 100,000; on a hard disk or NAS an order of magnitude more | first scan, then on every changed file | one-off | **fixed** (96 KB, full read only if no Exif there): 1.2 ms |
| 8 | Photo index re-scanned every minute while the Photos screen is used | 100,000 `stat` calls | every 60 s while browsing | ~60 rescans | **reduced** (5 min; uploads/deletes/refresh still rescan at once) |
| 9 | Renderer: a poster grid of 2,000 cards laid out and painted in full | 650 ms to first paint here (about 3 s on an old PC), 346 ms per re-layout (poster-size slider, window resize) | every visit to a big grid | every tab visit | **fixed** (194 ms; `content-visibility`) |
| 10 | Renderer: 1,009 KB of JavaScript parsed before the window can paint | parse + compile of the whole app | every launch | once | **fixed** (206 KB up front; screens load on first visit) |
| 11 | JSON list size: 779 KB for `/api/movies`, 283 KB for shows, 26 MB for all music tracks | seconds over Wi-Fi away from home | every list open | - | **fixed for clients that send `Accept-Encoding: gzip`** (7 to 12x smaller) |

Measured and **not** hot (so not changed): `playerPage()` builds its 55 KB page in 0.02 ms (1.5 ms across ~80 requests
in a CPU profile; the request's 22 ms is the session write and 16 settings reads), so memoising the shell would buy nothing;
HLS `prune()` lists the segment folder in 0.09 to 0.15 ms per segment request whether it holds 60 or 2,000 files (a
directory listing is cached by the OS at that size), so an in-memory segment index was not built; idle server CPU is 0.11% of one core.

## What was changed (each behind tests)

All of it is behaviour-preserving: no route shape, header (except `Content-Encoding`/`Vary` when a client asks for gzip) or
stored value changed.

1. **Settings read cache** (`electron/storeCache.js`, installed by `configStore.openStore`). One parsed copy of `config.json`
   answers `get()` while the file on disk is the one it was parsed from: dropped by every write through the store
   (conf's own `_write`), re-checked with a `stat` (mtime, size, inode) at most every 25 ms so a second Store instance, a
   restore or a hand edit is seen, never served past a parse error. Callers still receive their own copy of any object or
   array (a habit all over the app is `get` -> mutate -> `set`). Dotted keys and anything unusual go to conf itself.
   `BEEBO_NO_STORE_CACHE=1` turns it off. `test/store-cache.test.js`.
2. **Library cache** (`electron/catalog.js`): `quietValidMs` (2 min: a walk no folder watcher has reported a change in is
   trusted with no re-walk at all) and `staleWhileRevalidateMs` (10 min: past that, served immediately while a fresh walk runs on the
   worker). Off by default in `createLibraryCatalog`, on for the shared catalog, so the existing tests are unchanged.
   A reported change, an unwatchable or unplugged folder, or an older walk still walks first. `test/catalog-swr.test.js`.
3. **Memos** (`electron/parseMemo.js`): parsed file names (`parseMovieTitle`, show name/year/episode per file), a
   stat remembered for 60 s, a prefix join and an "added" lookup that replace 40,000 `path.join`/`resolve` calls, and
   a per-request poster index for TV (`tmdbCache.localImageIndex().hasTvPoster`). Bounded; each forgets everything when full.
   Results are copied per caller. `test/parse-memo.test.js` (equivalence to `path.join` for win32 and posix flavours).
4. **gzip for JSON** (`electron/compressJson.js`): only above 4 KB, only when the client sent `Accept-Encoding: gzip`,
   asynchronous. `test/compress-json.test.js` (including HEAD and Content-Length).
5. **Title sorts** use one `Intl.Collator` instead of `localeCompare(a, undefined, options)` (which builds a collator per
   comparison); identical order.
6. **Intro/credits scanner** (`introDetectJob.js`): the progress count is refreshed every 3 s instead of after every episode
   (exact at the end of a pass); the 40,000 `stat` calls yield to the event loop every 400; the detection results (about 500
   bytes per file, 20 MB at 40,000 files) live in `auto-markers.json` next to `config.json` instead of inside it, written at
   most every 5 s during a pass, and are moved over once from an older `config.json` (only removed from it after the new file
   is written). Before this every settings write anywhere rewrote tens of megabytes. `test/intro-scanner-scale.test.js`.
7. **Background gate** (`electron/backgroundGate.js`): automatic work waits while someone is watching (a viewer session, a live
   conversion, a stream, a Live TV recording), while the PC is on battery power, or while the CPU has been over 85% for two samples.
   Applies to: the intro scanner (it shows "Paused while the PC is on battery power" on the Dashboard), the seek-bar preview
   (trickplay) sweep (both share `houseIsBusy()` in `streamServer.js`), the automatic format
   conversions (not one a viewer is stuck on or one pushed to the front by hand), the timer-driven Music rescan, and the daily subtitle and
   metadata sweeps (delayed, never skipped). The Rescan button, "Sweep now" and the first scan of an empty library are unaffected.
   Settings (default on): `backgroundPauseOnBattery`, `backgroundPauseWhenBusy`; `BEEBO_BACKGROUND_ALWAYS=1` for a
   dedicated box. `test/background-gate.test.js`, `test/background-defer.test.js`.
8. **Photos**: Exif read from the first 96 KB (full 512 KB read only when nothing is found), index kept 5 minutes instead of 1.
   `test/photo-exif-firstread.test.js`.
9. **Renderer**: each screen is a lazy chunk (`App.jsx`); `.grid > .poster-card { content-visibility: auto }` (`styles.css`).
10. **Start-up**: `nodemailer` is loaded on first use.
11. **`tmdbCache` read cache** identifies a file by modified time *and size* (two writes inside one 15 ms Windows clock tick used
    to look identical). This also fixed `test/safe-json.test.js`, which failed about half the time on this machine before the change.

Found by the full suite and fixed: the gzip change first broke the Jellyfin mode, which calls the API handler in-process with the
caller's headers and read a compressed body as JSON. Only a real HTTP response is compressed now, and the in-process caller no
longer forwards `Accept-Encoding`.

## Left alone, deliberately

* **`tmdbCache` manifest writes** (22 ms per write at 2,000 titles, 49 ms at 5,000; pretty-printed with fsync + rename
  each). Compact JSON would save 15% of the bytes and 30% of the stringify, but the durable part (fsync, rename, `.bak`) is
  the cost, the file is meant to be hand-editable, and a debounce would trade the atomic-per-title guarantee. It only
  happens while matching a library for the first time, in the background.
* **HLS prune** and **the player page shell**: measured negligible (see above).
* **ETag / 304 for list routes**: the routes send `Cache-Control: no-store`, so a browser never sends `If-None-Match` and the
  native apps do not either; a 304 would need the clients to change first. gzip gives the bandwidth win without that.
* **`store.set` cost** (14 to 17 ms at 260 KB, 36 ms at 750 KB: the whole file is serialised with tab indentation and rewritten
  atomically on every write, e.g. every viewer progress report). Fixing it means splitting the settings file (history, users,
  markers into their own files or a database); the intro-scanner records were the one piece large enough to move now.
* **First scans**: music (tags of 50,000 files, 171 s) and photos (100,000 files, ~99 s) are unchanged; they run once and are then
  cached. The photo index is not persisted, so a restart with 100,000 photos re-stats them all.
* **The first walk after boot** (5.7 s here for 40,000 episodes, worse on a NAS or hard disk) still blocks the first list request.
* **`GET /api/music/tracks` with no `limit`** still returns all 50,000 tracks (26 MB, 2.2 MB gzipped); changing the default needs the
  apps updated first.
* **Renderer**: the poster cards are still all in the DOM (34,000 nodes for 2,000 cards) and every card re-renders when the
  page's state changes. Virtualising the grid (windowed rendering) is the real fix; `content-visibility` only stops the browser laying out and painting what is off screen.
  Trade-off measured: scrolling is 19 ms per frame instead of 17.5, with 2 of 200 frames over 34 ms (none before), for a 3.3x faster first paint.

## Recommendations for bigger structural work

1. **Split `streamServer.js`** (16,900 lines, one closure holding every route and cache) along the audit's plan: library lists
   (movies, shows, recently added, collections), player pages, admin, music/photos glue. The list builders share one shape
   (walk, look up metadata, badge, sort, filter) and would be the first module: a `libraryLists.js` with a per-library-version
   response cache would make a repeat `/api/movies` a lookup, and keyed on the catalog version it gives correct `ETag`s.
2. **Move the state that grows into files or SQLite**: watch history, users, playlists, markers and the review queue all sit in
   one `config.json` that is rewritten whole on every write. One file per domain (as done for `auto-markers.json`) or `node:sqlite`
   removes the 14 to 36 ms write and the remaining cache refills.
3. **Persist the library index** (path, size, mtime, parsed names) and diff it against a directory listing at start, so a
   restart does not wait for a 40,000-file walk, and paginate `/api/tvshows` (`limit`/`offset`, or shows first and counts
   later) so a 1,300-show library is not one 283 KB answer.
4. **Windowed poster grid** (`react-window` style) plus `React.memo` cards in `Movies.jsx`/`TVShows.jsx`: 34,000 DOM nodes
   for 2,000 titles is the renderer's remaining cost, and every keystroke in the search box re-renders them all.
5. **Photos**: persist the index, build it progressively (serve the newest page while older folders are indexed), and read
   Exif with one small read per file (done) from a worker; generate thumbnails through the background gate.
6. **Start-up**: `module.enableCompileCache()` needs Node 22 (Electron 31 ships Node 20), so move the rarely-needed
   modules (Jellyfin mode, storybooks, ACME/certs, busboy, the web admin's pages) behind lazy `require`s and measure again
   with `test/perf/require-profile.js`; the server currently loads 155 modules (about 280 ms warm here) before it listens.
7. **Expose the background settings** (pause on battery, pause when busy, and a new "only when the PC has been idle for N
   minutes", from `powerMonitor.getSystemIdleTime()`) in Settings, and give the Dashboard a "background work" line that says
   what is waiting and why.
8. **Compact settings serialisation**: pass `serialize: JSON.stringify` to the store (it writes tab-indented JSON today) and
   debounce progress writes; both are small and independent of the split above.
9. **Test with real media**: everything ffmpeg/ffprobe-shaped (probe, trickplay, HLS start latency, intro detection per file)
   needs `--real-video` runs; this synthetic library cannot show it.
