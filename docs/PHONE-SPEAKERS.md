# Phone speakers for movies (v1)

The big screen (the TV or the PC) shows the film. Each guest's phone plays **one channel of the film's sound**
(front-left, front-right, centre, surround-left, surround-right, bass) in sync, so a living room of phones becomes a
surround system. Guests join by scanning a QR code: no app, no account, no internet. It works on the home Wi-Fi.

Status: **In development.** Implemented and tested; the channel-cutting is measured on the real bundled ffmpeg and the
whole thing has been run in desktop Chromium (a TV tab and a phone tab). **It has not been run on a real phone, a real
TV browser or over a real Wi-Fi network.** The numbers below are labelled *measured*, *simulated* or *expected* so
nobody mistakes a target for a result. Nick, the manual test script at the bottom is how to change that.

## How it works

```
 details page (desktop)  or  the web player (TV / PC browser)
        | "Phone speakers"  (parental controls checked for the person who starts it)
        v
 phoneSpeakers.js  room: screen token + guest tokens, seats, shared timeline, hold-until-ready, beep test
        |                     ^ SSE (one stream per device) + JSON posts                  ^
        v                     |                                                          |
 phoneSpeakersAudio.js   one ffmpeg run per film cuts every channel as 5 s mono WAV pieces (cached, LRU)
        |  GET /speakers/audio/<FEED>/<n>.wav  (token in a header)                        |
        v                                                                                  |
 guest phone /speakers/join     TV / PC player panel (the film's <video> is MUTED)  --------+
   phoneSpeakersClient.js         phoneSpeakersWeb.js (same client library)
   clock sync -> Web Audio pieces chained on the shared clock -> drift nudges
```

* **The picture is the timeline master.** The screen's play / pause / seek / speed move the shared timeline, and every
  second the screen tells the room where its picture *really* is (`requestVideoFrameCallback` where the browser has it),
  so the phones follow the picture, not a prediction. The timeline has the same shape as Watch Together's
  (`watchTogetherSync.js`): "at server time `anchorAt` the film was at `anchorPos`".
* **After a seek the room holds** (the video pauses on its new frame, "Waiting for Sam...") until every phone that has
  tapped Enable audio reports its pieces are loaded, or 6 s pass; then everything starts again together 0.8 s ahead.
* **Join mid-film** needs no special case: the newcomer gets the running timeline, fetches the piece it is in and starts
  part-way through it, 150 ms ahead.
* **Rejoin** is automatic: the phone keeps its token in its own browser storage; a reload, a Wi-Fi blip or the server
  restarting its stream gets the same seat back. A phone that is gone keeps its seat for 20 minutes.

### Which sound each phone plays ("feeds")

`FL FR FC SL SR LFE` (+ `BL BR` on a 7.1) come straight from the film's channels (`hlsAudio.channelRoles` knows the
layouts). A channel the film does not have is **derived, never silence**: a missing centre is the phantom centre
(left + right, -3 dB), missing surrounds are the front pair at -6 dB, and the sub is the film's bass channel plus the low
end of the main channels (both low-passed at 120 Hz, 8 kHz sampling). `DL DR` are the stereo fold-down (the same
coefficients as the video converter's mix-down, with the limiter) and `DM` is the whole film folded to one channel.

Presets, from the panel:

| Layout | What each phone plays |
|---|---|
| Surround (default for 5.1 / 7.1 / 5.0 films) | join order FL, FR, centre, SL, SR, sub (+ BL, BR); extra phones are "Spare" until the host gives them a channel |
| Stereo pair (default for 2.0 films) | phones alternate left, right, left, right...: more phones add volume to a side |
| Everyone (default for mono films; the music-style party preset) | every phone plays the whole film folded to one channel |

The **seating chart** in the panel lists every phone with a channel picker (moving a phone swaps it with whoever has the
seat), a picture of the room, per-phone timing (-/+ 5 ms), mute and remove. Satellites get a 100 Hz high-pass (a phone
speaker cannot play the bass and buzzes trying), the sub phone a 120 Hz low-pass; both are ordinary Web Audio filters on the
phone, so they change instantly.

**When a phone leaves** (or has not tapped Enable audio, or is muted): "The TV plays the missing channel" (default: the TV
plays every channel no phone covers, through the same audio engine, placed left / right), "The nearest phone plays it too"
(a neighbour takes it at 0.75), or "Leave it silent". With no phone playing at all the film's own sound comes back on the TV
at once, and it also comes back when the picture is not at 1x speed (phones stay quiet then: Web Audio cannot keep the pitch).

## What the owner does

1. Details page of a film or episode: **Phone speakers** (there is a small "settings" link beside it). Or, in the web
   player (a TV browser, a PC browser), the **Phone speakers** button in the top bar. The person must be signed in and allowed
   to watch that title.
2. The player window opens with the QR code. Put it on the big screen. Guests scan it, type a name, tap **Join**, tap
   **Tap to enable audio** (a phone browser will not play sound until it is tapped once).
3. Press play on the film as usual.
4. Optional: Layout, moving phones, **Beep in turn / Beep together** to line them up, picture delay if the TV is late.

Settings (Details page > Phone speakers > settings, or the store keys): `phoneSpeakersEnabled` (default on),
`phoneSpeakersAllowRemote` (default **off**: only phones on the home network can join), `phoneSpeakersQuality`
(`standard` 32 kHz mono, `high` 48 kHz), `phoneSpeakersFillIn` (`tv` | `neighbour` | `off`).

## Sync design (the numbers are further down)

* **Clock sync** is the campsite synced-music algorithm (`docs/CAMPSITE-SYNCED-AUDIO.md`), ported: NTP-style
  `offset = ((t1-t0) + (t2-t3)) / 2`, 24 pings 60 ms apart on connect then 10 pings every 30 s, keep the lowest-RTT half,
  median, drop outliers beyond max(3 sigma, 3 ms), blend bursts (alpha 0.35, a jump over 40 ms is believed at once). It uses
  HTTP POST pings over a keep-alive connection (the desktop server has no WebSocket), so a ping is ~3 ms on loopback.
  `test/fixtures/phone-speakers-clock-vectors.json` holds the same vectors the campsite script is tested against, and a
  test runs both implementations on them and requires identical output.
* **Scheduling** is Web Audio only (no AudioWorklet: it needs HTTPS and a phone on `http://192.168.x.x` does not have it).
  A piece starts at the AudioContext time whose sound is *heard* at the right moment, mapped through
  `getOutputTimestamp()` (which includes the output latency where the browser reports it; fallback
  `currentTime - outputLatency`). Consecutive pieces are chained from one running map so they meet exactly (5 s at a whole
  number of samples per piece: 16-bit PCM has no codec delay; a lossy codec adds priming samples to every piece and could not).
* **Drift correction** every 250 ms: the median of the last 5 readings of (where the audio is) minus (where the room says it
  should be). Above 12 ms it nudges `playbackRate` by up to +-1% (about 17 cents, only while correcting) until it is back
  under 5 ms; above 60 ms it restarts the sources cleanly at the right place (at most once every 1.5 s).
* **Trim**: -/+ 5 ms on the phone (remembered on that phone), or from the seating chart. **Picture delay**: a room-wide
  slider for a TV that shows the picture late. **Output latency**: used where the browser reports it, and a phone that
  reports 90 ms or more is flagged as "probably Bluetooth" (on the phone and in the seating chart); a phone can also be told
  it is on a Bluetooth speaker.
* **Beep test**: the screen and every present phone beep in turn (different pitch each, two rounds) or all at once (one 30 ms
  tick per second, eight times), each scheduled on the shared clock with its own trim, so the owner hears the alignment and
  moves the trim until "together" sounds like one click.
* **Sync quality** per phone: green up to 30 ms estimated (clock error + current drift), amber up to 80, red above; grey away.
  It cannot see the output latency of a Bluetooth speaker, which is why the beep test exists.
* **Keep-alive** with no HTTPS: a silent looping `<audio>` element (holds a media session), the Screen Wake Lock where the
  browser allows it, lock-screen metadata. Whether that keeps a given phone alive with the screen off varies (see below).

### Accuracy

*Measured* (this PC, the bundled LGPL ffmpeg, a synthesized 5.1 film with a different pure tone in every channel):

| what | result |
|---|---|
| every feed carries only its own tone | own tone within 0.5 dB of full strength, every other channel's tone at least 60 dB down (the sub feed: 40 dB down, the main channels are low-passed away) |
| stereo fold-down / everyone mix | left = FL + 0.707 FC + 0.707 SL + 0.3 LFE within 0.5 dB of those gains; nothing of the other side |
| every piece is exactly 5 s | 160 000 samples at 32 kHz (40 000 at 8 kHz for the sub), from a run at the start and from a run started by a seek |
| a burst at 8.000 s of the film lands where the film says | 8.0000 s, 0.03 ms (one sample) from the start and after a seek |
| cutting speed (busy PC) | one feed 890x real time; all 9 feeds 95x real time, so a 2 h film's first 150 s (the look-ahead) takes about 2 s |
| disk | 64 KB per film-second per feed; all 9 feeds 528 KB/s; the look-ahead window is ~140 MB (50 MB on a weak PC), capped at 768 MB (256 MB weak, 1.5 GB fast) |

*Measured* in desktop **Chromium** on this PC, a TV tab and a phone tab against the real server on loopback (so no Wi-Fi, one
machine, one audio clock): the phone's clock estimate had 0.69 ms error at 3.0 ms RTT; over 20 s of steady playback its
measured drift stayed 0.4-1.4 ms with no nudge and no restart; a seek from the TV resumed the picture and the phone about
1 s later (0.8 s lead + loading); a reload of the phone tab rejoined the same seat; the browser reported 64 ms of output
latency. This validates the pipeline (handshake, clock sync, fetch, decode, scheduling, hold, resume). It says nothing about
Wi-Fi jitter or a phone's audio hardware, and it did not measure the sound at the speakers.

*Simulated* (node tests with a fake Web Audio world whose hardware clock runs fast or slow and whose speaker is 30 ms behind
the render clock; `test/phone-speakers-client.test.js`, run with `SPK_REPORT=1` to print them). Worst error of the audio
against the timeline after the first 4 s:

| audio hardware clock | worst | 95th percentile | corrections |
|---|---|---|---|
| perfect | 0 ms | 0 ms | none |
| 50 ppm off (typical phone) | 6.0 ms | 5.7 ms | none needed in 2 min |
| 100 ppm off | 11.9 ms | 11.4 ms | none in 2 min (it grows to the 12 ms threshold, then a nudge) |
| 100 ppm + 3 ms jitter in the browser's timestamps | 10.5 ms | 10.0 ms | 1 nudge, 0 restarts |
| -300 ppm + 3 ms jitter | 13.7 ms | 12.7 ms | 3 nudges, 0 restarts |
| 2000 ppm (far worse than any phone) | 28.6 ms | 21-25 ms | 11 nudges in 90 s, 0 restarts |
| clock estimate 5 ms wrong | 5.0 ms | 5.0 ms | (nothing can fix an estimate error from inside the phone) |

A 200 ms step in the clock estimate is a single clean restart. These numbers assume the clock estimate and
`getOutputTimestamp()` are right.

*Expected on real phones (not measured):* most phones within **10-25 ms** of the screen, an occasional 30-60 ms for a phone
with a noisy radio or a Bluetooth speaker until it is trimmed. Around 20-30 ms two speakers stop sounding like one, so this
is "together" for dialogue and effects and **not** a calibrated surround system: a hard-panned effect across two phones
that are a metre apart is at the mercy of that error. A TV browser adds its own display latency (the picture-delay slider
covers the constant part). Where the sound comes from a phone's tiny speaker, "surround" means direction and space, not bass
and not level: expect a room of small voices, with the TV or a real sub carrying the low end.

## Latency and the honest limits

* **Bluetooth**: 100-250 ms and most browsers do not report it; the phone warns when it does, otherwise use the beep test.
* **Wi-Fi**: 6 phones each fetching a 64 KB/s stream is 400 KB/s each way over the home network (about 2.5 Mbit/s total);
  fine for any router, but a phone on a weak signal will stutter first. The piece look-ahead is 2-3 pieces (10-15 s).
* **Phones sleeping**: the page must stay open. Locking the screen may stop it (browser dependent); the phone rejoins by itself
  when the page comes back. iOS Safari suspends the AudioContext after a call: the page asks for another tap.
* **Speed changes**: at anything but 1x the phones go quiet and the TV's own sound returns.
* **HDR / display lag**: not measured; use the picture delay slider.
* Nothing is verified on Safari, Firefox, Samsung Internet or a TV browser (the panel needs `requestVideoFrameCallback` for
  best accuracy and falls back to `currentTime`, which is coarser).

## Security and privacy

* The **room code** is 128 random bits (26 characters, the Watch Together generator). It is in the QR code and link only.
  A wrong code counts against the caller's address; 8 misses lock that address for 10 minutes; "no such room" and "you were
  removed" look identical. The page removes it from the address bar after loading.
* Guests have **no account**: a nickname and a **token** (128 random bits, stored only as a hash). Every call carries it in
  a **header** (never a cookie, never a URL), so a web page on another site cannot act for a phone; every POST is JSON,
  capped at 4 KB, and refused when it says it comes from another site. Only the room's **screen token** (issued to the
  signed-in person who started the room) can move the timeline, seat phones, change settings, kick or close.
* **Parental controls** are checked for the person who picks the film (the same rules and bedtime as watching it). Guests
  can only fetch the audio of that one film, through their token. (A room started before bedtime is not ended by bedtime; end
  it from the panel.)
* **Home network only** by default: requests from outside the home network are refused unless `phoneSpeakersAllowRemote`
  is on. The page and its script are static, carry no room data, and run under a strict CSP (`default-src 'none'; script-src
  'self'`); nothing is loaded from any other address, so it works with no internet.
* Names and titles are **data**: control and bidi characters removed, length-capped, and only ever written with
  `textContent`; the pages contain no string-to-markup code (a test scans for it). The QR code is an SVG made by this server
  and parsed as XML.
* **Limits**: 4 rooms, 16 phones per room, 64 streams, 2 stream connections per phone, per-call rate limits with a
  retry time, a slow client is dropped rather than buffered.
* **No data is collected**: rooms live in memory only and are gone when the room closes or the app stops; the log carries a
  short hash of the room, never the code, a name or an address. A phone stores its name, its trim, its Bluetooth tick and
  the room key + token (for the automatic rejoin) in its own browser; "Leave" or the end of the room clears the key.

## Files

`desktop/apps/desktop/electron/`: `phoneSpeakersChannels.js` (what each phone plays, the ffmpeg command),
`phoneSpeakersAudio.js` (the piece manager, throttling, LRU cache), `phoneSpeakers.js` (rooms), `phoneSpeakersHttp.js`
(HTTP, SSE, audio, the guest page), `phoneSpeakersServer.js` (wiring, settings, LAN addresses), `phoneSpeakersClient.js`
(the browser library and the phone page; served as `/speakers/client.js`), `phoneSpeakersWeb.js` (the TV / PC panel),
`phoneSpeakersIpc.js` (the details page button). Small edits to shared files: `streamServer.js` (one require block, one
wiring block, two route claims, one line in the player page, one return field, one close line), `hlsAudio.js` (exports
`roleTarget`), `main.js`, `preload.js`, `MovieDetail.jsx`, `TVShows.jsx`; the button is `src/components/PhoneSpeakersButton.jsx`.
The pieces live in `<temp>/beebo-playback/phone-speakers` (next to the video converter's), wiped when the app starts.

Tests (`desktop/apps/desktop/test/`): `phone-speakers-channels.test.js` (command building, and the **real ffmpeg** on the
synthesized 5.1 film), `phone-speakers-audio.test.js` (piece manager, fake and real ffmpeg), `phone-speakers-room.test.js`
(lifecycle, permissions, rate limits, XSS, seek / hold / rejoin), `phone-speakers-client.test.js` (clock vectors, link,
engine, simulated sync), `phone-speakers-http.test.js` (the HTTP door), `phone-speakers-server.test.js` (the real server
with real ffmpeg), `phone-speakers-web.test.js` (page source checks). Run one:
`NODE_PATH=<desktop node_modules> BEEBO_FFMPEG=<ffmpeg.exe> node --test test/phone-speakers-room.test.js`.

## Manual test script for the owner (about 10 minutes, 3 phones)

You need: the Beebo PC on the home Wi-Fi with a film that has 5.1 sound (or any film: it will be a stereo pair), 3 phones
on the same Wi-Fi (ideally 1 Android + 1 iPhone), and the TV or a second monitor for the player window. No internet needed.

1. **Start.** Details page of the film > **Phone speakers**. A player window opens with a QR code. Drag it to the TV. (No
   window? The film may be one you cannot watch, or the server is not running.)
2. **Join.** Each phone: camera > scan the QR code > type a name > **Join** > **Tap to enable audio**. Each phone shows its
   channel (Front left, Front right, Centre) and a green "In sync" within a few seconds; the TV overlay lists them. A phone
   that says "Reconnecting" or never syncs: note the phone and Wi-Fi.
3. **Beep test.** Panel > **Beep in turn**: the TV then each phone beeps in its own pitch, twice. Then **Beep together**: it
   should sound like one tick. Put two phones side by side: a flam or echo is out of sync. Note the offset you hear.
4. **Play.** Press play on the TV. Dialogue should come from the centre phone, effects and music from the sides. The TV
   video is muted (except the channels no phone covers). Walk around: is it "together"? Note anything that echoes.
5. **Seek.** Jump ahead and back: the picture waits ("Waiting for ...") a second, then everything starts together. Note
   how long the wait is and whether any phone starts late or stays silent.
6. **Late joiner.** Join a fourth phone mid-film: after its tap it should catch up within about 1-2 s.
7. **A phone leaves.** Close the browser tab on one phone: after a few seconds its channel moves to the TV (default). Change
   "When a phone leaves" to the nearest phone and to silent; check each. Reopen the page on that phone: it should rejoin its
   seat by itself.
8. **Stereo pair and Everyone.** Try both layouts with the 3 phones.
9. **Bluetooth.** Connect one phone to a Bluetooth speaker: does the page warn? Use the timing buttons until Beep together
   sounds like one tick; note the value needed.
10. **Screen off.** Lock one phone for 30 s: does the sound continue? Unlock: does it catch up by itself?
11. **Wi-Fi edge.** Walk one phone to the edge of the Wi-Fi and back: it should say Reconnecting, then rejoin.
12. **Measure** (optional, the real number): put two phones next to each other, play a film scene with sharp effects on the
    same channel layout (Everyone), record both with a 240 fps phone camera pointed at the screens or with a microphone, and
    read the offset between the clicks at 10 s, 2 min and 10 min (drift). Write the numbers into this file.
13. **End.** Panel > **End phone speakers**: the phones say the movie night has ended and the film's own sound returns.

Record per phone: model, browser, "In sync" colour, worst and typical offset, whether the screen-off trick worked,
Bluetooth latency, battery use over 30 minutes.

## What still needs real devices (not verified)

* Real sync error on real phones over a real Wi-Fi network (everything above marked measured was loopback in one browser).
* `getOutputTimestamp` / `outputLatency` per browser (Safari especially), Bluetooth latency, and whether the browser's
  numbers are honest.
* The silent-audio keep-alive and Wake Lock on Android Chrome, Samsung Internet and iOS Safari with the screen locked.
* Decode memory and the fetch/decode cadence on low-end phones (a decoded 5 s piece is about 1 MB; 3 or 4 are held).
* A real TV browser (Samsung / LG / Fire TV / Chromecast with Google TV) as the "screen": `requestVideoFrameCallback`, the
  autoplay unlock, the panel's usability with a remote.
* Six or more phones fetching pieces at once on a busy router; the "cut speed" number on a truly weak PC.
* Whether guests find the QR code and the "Tap to enable audio" step obvious.

## Deferred (not built)

* Playing sound from the *host phone's own* film session or the Android app as a "screen" (the Android apps are not touched).
* Non-1x speeds for the phones (needs server-side time-stretch pieces per speed).
* A separate `/tv` page (the panel lives in the web player, which a TV browser can open); the Movie Night hub (another agent)
  can start a room by calling `phoneSpeakersServer.getActive().createForOwner(...)`.
* Next-episode handover inside one room (start a new room for each title).
* Saving a room's seating for next time; Atmos / object audio (it plays as regular surround, as everywhere else in Beebo).
* Lossy pieces (AAC / Opus) to save Wi-Fi: rejected on purpose for v1 (priming samples break sample-exact chaining).
