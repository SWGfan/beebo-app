# Audiobooks

Audiobooks are a first-class library next to Movies, TV, Music and Photos. Books live in the owner's own
files; nothing is downloaded, bundled or scraped. The design follows the Music library (same scan, cache,
media-token and Range-streaming patterns) plus what audiobooks need: chapters, series, per-person resume
positions, bookmarks, speed and a sleep timer.

## What is a book

| On disk | Book |
|---|---|
| `Title.m4b` (any folder) | one book, chapters from the file |
| a folder of `.mp3 .m4a .flac .ogg .opus .wav .aac` | one book made of parts (files) |
| `CD1/`, `Disc 2/` sub-folders | folded into the folder above them |
| a lone audio file in a folder | one book |
| loose files straight in the Audiobooks folder | one book each, never merged |
| `.aax`, `.aaxc`, `.aa` (Audible) | **skipped**, listed in Settings and `GET /api/audiobooks/skipped` |

Beebo does not remove copy protection. Protected Audible files are never opened, only reported, with a plain
explanation. Use books you already have in an open format.

Folders are read as `Author/Series/NN - Title`, `Author/Title` or `Title`. A leading number with a separator
(`03 - `, `Book 3 - `, `#3.`) is the book's place in its series. Disc folders and "Author/Title/Title.m4b"
(folder named like its file) are handled.

## Where each detail comes from

1. The files' tags (`music-metadata`, `ffprobe` as the fallback): album = title, artist = author, narrator from
   `NARRATOR` / `©nrt` / composer, series from `MVNM`+`MVIN`, `SERIES`+`SERIES-PART` or `grouping`
   ("Discworld, Book 5"), year, genre, description, embedded cover.
2. The title and folders: "The Way of Kings (The Stormlight Archive #1)" and "Mistborn, Book 1: The Final Empire"
   are understood; "Last, First" author names are turned around (one-word family names only).
3. Optional Open Library answer, only for fields still empty (below).

Series ids are author + series name, so two authors with a series of the same name stay separate.

## Chapters

In this order, first that yields at least two chapters:

- the MP4 `chpl` atom (what ffmpeg, mp4v2 and most audiobook tools write), read straight from the file without
  ffmpeg (`audiobookChapters.readMp4Chapters`, walks the top-level boxes so a moov after gigabytes of audio is cheap);
- MP4 chapter tracks and ID3v2 `CHAP` frames (`music-metadata`), `ffprobe -show_chapters` for m4b/m4a as the last resort;
- a `.cue` sheet beside the book (same name, or the only cue in the folder; UTF-8, UTF-16 or Latin-1; a
  multi-`FILE` cue for a folder of files maps by file name);
- folder books: one chapter per file (or the files' own chapters when they have them).

Chapters are `{ title, start, end }` in **whole-book seconds**. Everything the API says about positions is
whole-book seconds; a book also lists its `parts` (`start`, `duration`) so a client can find the right file.

## API

Everything is under `/api/audiobooks` and needs the app's bearer token, except the audio (also a media token
signed for `audiobook:<book id>`, `?mt=` or `X-Beebo-Media-Token`) and covers (content-hash capability URL).
See the header of `electron/audiobookApi.js` for the full list. The important ones:

| Route | |
|---|---|
| `GET /books[?authorId&seriesId&q&sort&status&offset&limit]` | books with this person's progress and status |
| `GET /book/<id>[?tokens=1]` | chapters, parts (with stream URLs), progress, bookmarks, next in series, prefs |
| `GET /book/<id>/stream[/<part>]` | Range audio; `?codecs=` / `?quality=` convert like Music (only when the player cannot decode it) |
| `GET /series`, `/series/<id>`, `/authors`, `/author/<id>`, `/search?q=` | grouping |
| `GET /continue` | the "continue listening" shelf, plus "up next in your series" |
| `GET /reading-order[?seriesId\|authorId][&standalone=1]` | each series in reading order, a status on each book, the next one flagged |
| `PUT /book/<id>/progress` | `{ position, speed?, deviceId?, updatedAt? }` |
| `POST /progress/batch`, `GET /progress?since=` | a device catching up after being offline |
| `POST /book/<id>/finished`, `DELETE /book/<id>/progress` | mark finished / start over / forget |
| `GET/POST /book/<id>/bookmarks`, `PUT/DELETE .../<bookmarkId>` | bookmarks |
| `GET/PUT /prefs` | speed, skip back (15 s), skip forward (30 s), sleep timer defaults |
| `POST /rescan`, `GET /skipped`, `GET/POST /lookup` | owner only |

### Progress and syncing

Stored per person in the app store under `audiobookProgress[userId]` (removed with the account by
`userDeletion.purgeUserData`; treated as private viewing data by `backup.js`). Per book: `position`, `duration`
(always the library's, never the client's), `updatedAt`, `startedAt`, `finishedAt`, this book's `speed`,
`deviceId`, `bookmarks`.

**Newest listen wins.** A save whose `updatedAt` is older than what is stored is ignored (`applied: false`) and the
caller gets the stored progress back, so a phone that was offline for a day cannot drag the position back over
what the car heard this morning. A client clock in the future is pulled back to now + 60 s. Reaching the last few
seconds (2% of the book, between 5 and 45 s) marks it finished; scrubbing back un-finishes it.

Speed is 0.5x to 3x in 0.05 steps (pitch preserved: `preservesPitch` on the media element). Sleep timers
(N minutes with a 10 s fade, or end of chapter) are client-side clocks; the last choice is stored in prefs.

## Clients

- **Website** `/audiobooks` (`audiobookWeb.js`): continue-listening shelf, all books / series / reading order,
  player with chapter list, speed, sleep timer, skip buttons, bookmarks, Media Session (lock-screen) controls.
  Its data calls go to `/audiobooks-api/*` with the login cookie (cross-site writes are refused).
- **Desktop** Audiobooks tab (`src/components/Audiobooks.jsx`) through `window.beeboentertainment.audiobooksCall`
  (`main.js 'audiobooks:call'`, the same JSON contract run as the owner). Settings has the folder and the lookup switch.
- **Phone / TV / car apps**: the API above; no native UI ships in this change (see "Not done yet").
- The player arithmetic (`electron/audiobookPlayer.js`) is inlined into the website page with `.toString()` and
  copied byte-for-byte to `src/lib/audiobookPlayer.js` for React; `test/audiobook-player.test.js` fails if they differ.

## Settings and headless

Keys: `audiobooksDir`, `extraAudiobooksDirs`, `audiobooksOnlineLookup` (default off). Docker/headless:
`BEEBO_AUDIOBOOKS_DIRS` or a `/media/audiobooks` mount.

## Optional Open Library lookup

Off by default; one checkbox in Settings. When on, `audiobookMetadata.js` sends **only the title and author** as
a search to `openlibrary.org` (User-Agent `BeeboEntertainment/1.0 (support@beeboentertainment.com)`, one request
at a time, at least 1.2 s apart, answers cached, a book with an answer is never asked again, one with no answer
is retried after 30 days), and stores the first-published year, one subject as the genre, the catalogue key and,
for a book with no cover, the cover picture. Only a same-title, same-author-word match is accepted. Never
overwrites what the files said. Google Books and Audnexus are deliberately not used (terms).

## Tests

`test/audiobook-chapters.test.js` (chpl/cue/ffprobe/ID3 chapters, naming), `audiobook-library.test.js` (planning,
assembly, scans, incremental rescans, real ffmpeg m4b + flac), `audiobook-progress.test.js` (progress, bookmarks,
prefs, the lookup with a stubbed network), `audiobook-player.test.js`, `audiobook-api.test.js` (the routes through
the real stream server, the website page, account deletion, conversion).

## Not done yet

Native phone / Android Auto / TV screens (the API is ready), podcasts and LibriVox/Gutenberg empty-state content,
embedded-chapter editing, per-user "hide finished", an in-page sleep timer shake gesture, gapless part hand-over
(the browser reloads at each part boundary), iOS background-audio specifics beyond Media Session.
