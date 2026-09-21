# Live TV and DVR

Watch and record over-the-air TV from **your own antenna** through **your own** SiliconDust HDHomeRun network
tuner. Code: `electron/liveTv/`. Tests: `test/livetv-*.test.js`.

## What it is not (legal posture)

- Beebo supplies **no channels, streams, channel lists or guide data**, and links to none.
- Only your own tuner on your own network is contacted. Nothing goes through Beebo servers.
- Copy-protected (DRM-flagged) channels are hidden and never played.
- A generic "M3U + XMLTV" source is **not implemented**. `GET /api/livetv/advanced` reports it as unavailable and
  `POST /api/livetv/admin/advanced/m3u` answers 501 with the warning. If it is ever added it must be off by default,
  behind an owner setting, with the plain warning that Beebo does not supply channels and that only sources the
  owner is licensed to use may be added.

## How it works

| Piece | File | Notes |
| --- | --- | --- |
| Address checks | `netGuard.js` | Tuner address = IPv4 literal, private/link-local only unless the owner explicitly confirms; loopback/public need `confirmNonLan`; 0.0.0.0, multicast, broadcast and 169.254.169.254 never. No redirects, size and time caps. Nothing a device reports (BaseURL, LineupURL, per-channel URL) is ever used as an address. |
| HDHomeRun protocol | `hdhr.js` | UDP discover on 65001 (only replies from LAN addresses are believed, CRC and lengths checked), `/discover.json`, `/lineup.json`, `/lineup_status.json`, `POST /lineup.post?scan=start`, stream `http://<ip>:5004/auto/v<GuideNumber>`. |
| Tuner slots | `tunerPool.js` | One connection per channel, shared by every viewer and a recording of that channel. Busy = polite message. A recording may take a viewer-only tuner (viewers are told); a viewer never takes a recording's. 503 from the tuner = "in use by another app". Stalled tuner is torn down. |
| Watching | `liveHls.js` | ffmpeg reads the shared stream on stdin: yadif (interlaced frames only), H.264 with the encoder `hlsTranscoder.js` proved (hardware first), stereo AAC through the `hlsAudio.js` limiter, 2 s pieces. Beebo builds the sliding live playlist itself (default 90 min rewind buffer, disk-capped, no ENDLIST while live). Idle viewers dropped after 45 s, a viewer that only pauses is dropped after 20 min; the last viewer leaving releases the tuner. |
| Guide | `guide.js`, `xmltv.js` | XMLTV file or URL (URL fetch is SSRF-guarded). No guide = channel names only. Reading the antenna's own EIT/PSIP tables was assessed and not done: the tuner's stream is filtered to one programme and ffmpeg does not decode those tables. |
| DVR | `dvr.js` | One-off recordings and series rules (both explicit); padding; conflict detection (tuner count, same channel shares a tuner) when scheduling; `.mkv` via ffmpeg `-c copy` or raw `.ts`; files as `Show/Season N/Show - SxxEyy.ext` inside the Recordings folder (add it to the library from Settings); keep-latest-N; state in `dvr.json`; survives restarts. |
| Service and routes | `index.js`, `webUi.js` | Everything below. |

State files (all through `safeJson.js`): `livetv.json`, `livetv-users.json` (favourites), `guide-cache.json`,
`dvr.json`, next to the settings file (`<userData>/livetv/`).

## Who may use it

Any signed-in household member, except **profiles with parental controls and guests from a shared library**:
parental controls rate films and shows, not channels, so there is nothing to filter a live channel by. Setting up
tuners, the guide and the recordings folder is owner-only. Recording is owner-only unless the owner switches on
"let everyone schedule recordings".

## HTTP contract

`/api/livetv/<sub>` (bearer token) and `/livetv-api/<sub>` (login cookie, same-site POSTs only). Same JSON.

- `GET status`, `GET channels[?all=1]`, `GET guide?hours=3`, `POST favourite {channel,on}`
- `POST watch {channel,quality?}` -> `{ url: "/livetv/hls/<ticket>/index.m3u8", ticket, live: true, ... }`;
  `POST stop {ticket}`; 503 `tuners_busy` with a plain message when every tuner is in use
- `GET dvr`, `POST dvr/schedule|cancel|delete|rule|rule/remove|rule/set`
- owner: `POST admin/discover|device|device/remove|lineup/refresh|scan|channel|settings|guide/source|guide/refresh|guide/map|recordings/add-to-library`

The playlist and pieces (`/livetv/hls/<ticket>/...`) need no login: the signed ticket is the credential (Cast and
apps cannot send cookies). Tickets are redacted from logs. Players only ever see these addresses, never the tuner's.

Players: the web page `/livetv` and `/livetv/watch` (hls.js, LIVE badge, pause, +/-30 s, Go live, channel keys) and the
desktop Live TV tab use them. The playlist is an ordinary live HLS playlist (MPEG-TS pieces, H.264 + AAC), which
Media3/ExoPlayer plays natively; the Android app still needs a Live TV screen that calls this API (not done here).

## Needs a real HDHomeRun to verify

See the delivery notes in the final report of the build: UDP discovery on a real network, real `lineup.json` DRM flag
values, `/auto/v` behaviour when tuners are busy elsewhere, 1080i/MPEG-2/AC-3 sources through the encoders, hardware
encoders with live input, long-running rewind buffers and recordings.
