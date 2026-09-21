# Podcasts and Internet Radio

Two features that share one player bar and one outbound-network guard. Both are legal by construction:
podcasts come from standard public RSS feeds the person subscribes to, radio stations come from the open
Radio Browser community directory or an address the person typed. Nothing is scraped from a paid or
licensed service and nothing copyrighted is bundled.

Code: `desktop/apps/desktop/electron/` (`podcastService.js`, `podcastApi.js`, `podcastFeed.js`,
`xmlLite.js`, `htmlSanitize.js`, `id3Chapters.js`, `radioService.js`, `radioApi.js`, `radioBrowser.js`,
`icy.js`, `outboundFetch.js`) and `src/` (`components/Podcasts.jsx`, `Radio.jsx`, `MiniPlayer.jsx`,
`lib/audioPlayer.js`). Tests: `test/podcast-*.test.js`, `radio-*.test.js`, `outbound-fetch.test.js`,
`audio-player.test.js`, with fixtures in `test/fixtures/podcasts` and `test/fixtures/radio`.

## What people can do

**Podcasts** (desktop app: Podcasts tab; phone/TV: `/api/podcasts`)

- Find shows (Apple iTunes Search API, used only to learn a show's feed address) or paste an RSS address.
- Import and export an OPML subscription list.
- Background refresh with conditional GET (`ETag` / `If-Modified-Since`), back-off after failures.
- Episode list, played / progress / queue, all per account. The next queued episode plays by itself.
- Auto-download the newest N episodes of a show into a capped folder, with automatic cleanup.
- Chapters: Podcasting 2.0 `podcast:chapters` JSON, Podlove inline chapters, and ID3 `CHAP` frames of a
  downloaded MP3.
- Speed 0.5x to 3x in 0.05 steps with the pitch kept (`preservesPitch`), skip back 15 s / forward 30 s,
  a sleep timer (5 to 60 minutes or end of episode), optional skip-silence for downloaded episodes.

**Internet radio** (Radio tab; `/api/radio`)

- Browse and search by name, country, genre and language (Radio Browser), favourites, recent stations.
- Your own stations by stream address (also `.pls` / `.m3u` playlist addresses; HLS is refused).
- "Now playing" from the stream's ICY metadata, shown in the player bar.
- The server relays the stream and reconnects by itself when the station drops; several listeners of one
  session share one upstream connection.
- Recording a station to a file exists but is **off by default** (see below).

## How it is built

```
Podcasts.jsx / Radio.jsx --IPC--> main.js 'podcasts:call' / 'radio:call' --> streamServer.podcasts()/radio()
phone / TV -------HTTP /api/podcasts/*, /api/radio/* (bearer token) -------> podcastApi.js / radioApi.js
                                                                   |                      |
                                                            podcastService.js      radioService.js
                                                            (state.json, feeds/,   (state.json, sessions,
                                                             downloads/)            recordings/)
                        every outbound request --> outboundFetch.js (SSRF guard)
```

The desktop calls the same JSON contract as the phone, in-process, as the owner. Audio comes back as
`http://127.0.0.1:<port>/api/.../stream?mt=<media token>` for the in-app `<audio>` element.

Storage sits beside the app store: `podcasts/state.json` (shows and each person's state; atomic writes via
`safeJson.js`, `.bak` kept, a damaged file is set aside as `.corrupt-<time>`), `podcasts/feeds/<show>.json`
(episodes), `podcasts/downloads/`, and `radio/state.json`, `radio/recordings/`. Account deletion
(`userDeletion` call sites in `streamServer.js`) removes a person's subscriptions, progress, queue,
favourites, custom stations, open streams and recordings, and any show only they followed.

## HTTP API

Everything needs the app's bearer token except an audio stream, which also accepts a media token
(`?mt=` or `X-Beebo-Media-Token`, signed for `podcast:<episode>` / `radio:<session>`). Add `?tokens=1` to
get streams with a token already attached. Errors are `{ ok: false, error: '<code>' }`.

Podcasts (`/api/podcasts`): `GET status`, `GET search?q=&country=`, `GET|POST subscriptions`,
`POST|DELETE subscriptions/<show>`, `POST refresh {showId}` (`{all:true}` is admin only), `GET|POST opml`
(raw XML body or `{opml}`), `GET show/<show>?offset&limit&unplayed&oldest`, `GET latest`, `GET continue`,
`GET|POST queue`, `DELETE queue/<ep>`, `POST queue/reorder|clear`, `GET episode/<ep>` (sanitized notes),
`POST episode/<ep>/progress|played`, `GET episode/<ep>/chapters`, `GET|POST|DELETE episode/<ep>/download`,
`POST episode/<ep>/skip-silence`, `GET episode/<ep>/stream[?variant=nosilence]` (Range),
`GET|POST prefs`, `GET settings`, `POST settings` (admin), `POST cleanup` (admin).

Radio (`/api/radio`): `GET status`, `GET browse?name&country&countryCode&language&tag&order&limit&offset`,
`GET lists/countries|languages|tags`, `GET|POST favorites`, `DELETE favorites/<id>`, `GET|POST custom`,
`POST|DELETE custom/<id>`, `GET recent`, `POST play {stationId | url,name}`, `GET session`,
`GET|DELETE session/<id>`, `GET session/<id>/stream`, `POST|DELETE session/<id>/record`,
`GET recordings`, `GET recordings/<id>/file[?download=1]`, `DELETE recordings/<id>`, `GET settings`,
`POST settings` (admin).

Bedtime and daily-limit rules that stop Music also stop listening here (`/stream` with a bearer token).

## Security

- **Outbound requests** (`outboundFetch.js`, following `webhooks.js`): the host is resolved and every
  answer judged. Link-local (cloud metadata), multicast, "this network" and reserved addresses are never
  reachable; loopback / RFC 1918 / CGNAT / unique-local addresses only when the owner switches on
  "allow my own network" (Podcasts > Settings, Radio > Settings, off by default). The connection is pinned
  to the addresses that were judged. Redirects are followed by hand, at most 5, and every hop is judged
  again. Only `http:` / `https:`, no credentials in the URL, a time limit, a byte limit, and compressed
  answers are unpacked under the same byte limit (gzip-bomb safe).
- **Fixed-host services** (Apple's directory, Radio Browser) additionally use `safeFetch.vetUrl`: https,
  port 443, no credentials, host on an allow-list, re-checked on every redirect hop.
- **ffmpeg** (skip silence) gets its input through `ffmpegArgs.inputArgs` (`file:` prefix and a protocol
  whitelist), as an argument array, never a shell string.
- **XML** (`xmlLite.js`): a DOCTYPE that declares anything (entities, internal subset, SYSTEM/PUBLIC ids) is
  refused: no XXE, no entity expansion. Only the five predefined entities and numeric references decode.
  Caps on size, element count, depth and attributes; linear-time scan, no recursion.
- **Show notes** (`htmlSanitize.js`): tag allow-list with no attributes except links (http, https, mailto
  only, `rel="noopener noreferrer nofollow" target="_blank"`); script/style/iframe/object/svg and similar
  are dropped with their content; entities decoded once and re-escaped. Sanitized on the server, so the
  stored and served form is already safe.
- **Per-account data**: every state route is scoped to the caller's id. Another person's session, station,
  recording or progress answers like something that does not exist (404 / `not_subscribed`). Owner-only:
  settings, refresh-all and cleanup.
- **Logs** never contain a feed or stream URL (private feeds carry tokens in the query string); the server
  log goes through `redactSecrets` as everywhere else.
- Radio streams are relayed with `X-Content-Type-Options: nosniff`, only when the type is audio.

## Recording (off by default)

A listener can record the station they are hearing to a file only if the owner ticked "Allow recording"
in Radio > Settings. It is per session, explicit (a button), capped per file (`maxRecordingMb`, default
512) and in total (`recordingsCapMb`, default 2048), saved only for the person who started it, and never
shared. The audio saved is the audio the player heard (ICY metadata removed) plus a list of the titles
that played. It is for time-shifting what the person has the right to listen to.

## Speed and silence

`clampSpeed` (0.5 to 3, 0.05 steps) is the same on the server (`podcastService.js`) and in the player
(`src/lib/audioPlayer.js`); a test keeps them equal. The player keeps the pitch with `preservesPitch`.
Skip silence runs `ffmpeg -af silenceremove` (leading silence trimmed, pauses over 0.5 s shortened to
0.2 s) on a **downloaded** copy in the background, one job at a time, and writes `<episode>.ns.m4a` next to
it. The trimmed file has its own timeline, so chapters are not shown while it plays and progress is only
saved at the finish.

## Legal and terms notes

- Apple iTunes Search API: public, free, no key; used for discovery only, cached ten minutes, limited to
  15 requests a minute for the whole household (Apple asks for roughly 20). Only the show name, author,
  artwork address and feed address are kept from it; results are labelled as coming from Apple's
  directory.
- Radio Browser: mirrors are discovered from `all.api.radio-browser.info/json/servers`, one is chosen at
  random and failed ones are skipped; the User-Agent names the app and version; the "click" call is made
  when a listener starts a station; requests are cached and rate limited.
- Episode audio and station streams come from their publishers. Downloads are a personal, capped cache.

## Not done yet / deferred

- The website (`/podcasts`, `/radio` pages beside `/music`) and the phone/TV apps: the API is ready, the
  pages are not built.
- `itunes:new-feed-url` is recorded on the show (shown as `newFeedUrl`) but not followed automatically.
- Transcripts are parsed (`transcripts` on an episode) but not displayed.
- Radio recordings can be listed and deleted in the desktop app, but not played or exported from it yet
  (the file route exists at `/api/radio/recordings/<id>/file`).
- HLS radio stations are filtered out; only progressive audio streams are supported.
- Podcast Index API (needs a key) and Spotify/Apple catalogues are deliberately not used.
