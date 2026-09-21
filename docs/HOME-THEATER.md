# Home theatre: 4K HDR, Dolby Vision, Dolby Atmos, DTS and AV receivers

Written for the owner and for whoever maintains the player code. It says what Beebo does today, what was
actually tested, and what has **not** been tested because it needs a real TV, receiver or Apple device.

Google's summary of Beebo said it "falls short for home theaters". Status of its four points:

| Point | Status |
|---|---|
| No hardware transcoding engine | Built earlier: encoder probe + automatic fallback (`desktop/apps/desktop/docs/TRANSCODING.md`). |
| No big-screen clients | Android TV / Fire TV, Apple TV, Roku, Samsung, LG, Xbox clients exist in `apps/*` (Roku, Samsung, LG, Xbox, Apple never ran on real hardware, see CLAUDE.md section 9). |
| **No high-end audio / video (4K HDR10+, Dolby Vision, Atmos, DTS:X, receiver passthrough)** | **This document.** Files are classified precisely, clients say what they can play, the server picks direct play / direct stream / transcode per stream, and HDR and Dolby Vision video plus Dolby Digital (Plus / Atmos) sound are *copied* untouched for players that need HLS. |
| Always-on server | Headless / Docker exists. |

Code map (all under `desktop/apps/desktop/electron/`):

| File | Job |
|---|---|
| `mediaClassify.js` | What a file IS: resolution class, HDR type, Dolby Vision profile, bit depth, colour, audio family, Atmos / DTS:X, badges. Pure. |
| `deviceProfile.js` | What a client CAN do: the declaration format, conservative platform defaults, User-Agent detection. Pure. |
| `playbackDecision.js` | Direct play / direct stream / transcode, video and audio decided separately, with machine-readable reasons. Pure. |
| `hlsRemux.js` | Direct stream: key frame index, fragmented-MP4 HLS with the picture copied, DV / HDR10 tags, seek runs. |
| `homeTheater.js` | The routes: `/playback/negotiate`, the `homeTheater` block of `/playback/info`, the remux tickets. |
| `homeTheaterSettings.js` | Settings > Playback > Home theater, with a per-person override. |
| `playbackApi.js`, `playbackTracks.js`, `libraryInfo.js`, `mediaInfo.js`, `jellyfin/playback.js` | Small edits that expose the above. |

## 1. What every file is classified as

`mediaClassify.js` reads raw ffprobe JSON. Everything below appears in `GET /api/playback/info`
(`video`, `audio[]`, `homeTheater`), in the library Table view (a **Home theater** column, better **HDR**
column, Atmos / DTS:X badges on posters), on the movie details page (a **Formats** row), and in the
Jellyfin-compatible `MediaStreams`.

| Fact | Values |
|---|---|
| Resolution class | SD, 480p, 576p, 720p, 1080p, 1440p, 4K, 8K (a 1920x800 scope film is 1080p; 3840x1600 is 4K) |
| HDR type | SDR, HDR10, HDR10+, HLG, Dolby Vision; `hdrFormats` lists every one present ("Dolby Vision", "HDR10" for a profile 8.1 file) |
| Dolby Vision | profile 4/5/7/8/9/10, the label (`8.1`, `8.4`, `7 (dual layer)`), level, base-layer compatibility id (1 HDR10, 2 SDR, 4 HLG, 6 Blu-ray HDR10), RPU / enhancement-layer flags, what a non-Dolby player sees (`baseLooksLike`) |
| Picture | bit depth (8/10/12), chroma, colour primaries, transfer (PQ / HLG), matrix |
| Audio family | Dolby Digital (`dd`), Dolby Digital Plus (`ddp`), Dolby TrueHD (`truehd`), DTS / ES / 96-24 (`dts`), DTS-HD HRA / MA / DTS:X (`dtshd`), AAC, FLAC, PCM ... |
| Object audio | `atmos` (in Dolby Digital Plus "JOC" or in TrueHD) and `dtsx`; `spatialFormat`: `DolbyAtmos`, `DTSX`, `None` |
| Layout | Mono, Stereo, 5.1, 6.1, 7.1, 7.1.4 ... (Atmos files report their bed: 5.1 or 7.1) |
| Badges | `4K`, `Dolby Vision`, `HDR10+`, `HDR10`, `HLG`, `10-bit` (SDR only), `Atmos`, `DTS:X`, `TrueHD`, `DTS-HD MA`, `7.1` |

Example (UHD Blu-ray remux): `["4K", "Dolby Vision", "HDR10", "Atmos", "7.1"]`.

Jellyfin-compatible fields on every video stream: `VideoRange`, **`VideoRangeType`** (`SDR`, `HDR10`, `HDR10Plus`, `HLG`,
`DOVI`, `DOVIWithHDR10`, `DOVIWithHLG`, `DOVIWithSDR`, `DOVIWithEL`, `DOVIWithHDR10Plus` ...), `DvProfile`, `DvLevel`,
`DvBlSignalCompatibilityId`, `RpuPresentFlag`, `ElPresentFlag`, `BlPresentFlag`, `VideoDoViTitle`, `BitDepth`, `ColorPrimaries`,
`ColorTransfer`, `ColorSpace`, `Profile`, `Level`; and on every audio stream **`AudioSpatialFormat`** (`None` / `DolbyAtmos` /
`DTSX`), `Profile`, `ChannelLayout`.

### What ffprobe can and cannot tell us

* **Dolby Vision** comes from the stream's DOVI configuration record (MP4 `dvcC` / `dvvC` box, Matroska block-addition
  mapping; only the MP4 route was tested). A raw HEVC stream with RPU NAL units but no record is not detected. Verified with real
  ffprobe on an MP4 with a `dvcC` box (see section 7).
* **HDR10+** is per-frame metadata (SEI). It is read by one extra, tiny ffprobe call over the first frames, made only for
  HEVC / AV1 / VP9 pictures with a PQ transfer. Not verified against a real HDR10+ file (none was available; ffmpeg cannot
  make one without external tools). The fixtures use the side-data name ffprobe prints.
* **Atmos / DTS:X** are recognised from ffprobe's audio `profile` ("Dolby Digital Plus + Dolby Atmos", "Dolby TrueHD + Dolby
  Atmos", "DTS-HD MA + DTS:X"). An older ffmpeg prints no such profile; then the track *title* is used as a hint and the result
  is marked `inferred: true`. Not verified against real Atmos / DTS:X files: the profile strings are from ffmpeg's source, and the
  fixtures are hand-written from that shape.

## 2. How a client tells the server what it can play

A client sends a compact declaration with its playback request, in the body of `POST /api/playback/negotiate` as
`deviceProfile` (an object, or JSON, or base64url JSON) or in the `X-Beebo-Device-Profile` header, and names itself with
`client` in the body or the `X-Beebo-Client` header (that header is already allowed for TV apps by `corsPolicy.js`).
Everything is optional. Body fields are preferred for packaged TV apps (no extra CORS header).

```json
{
  "kind": "movie", "id": "<file id>",
  "client": "androidtv",
  "deviceProfile": {
    "v": 1, "name": "Living room Shield",
    "video": {
      "h264": { "profiles": ["baseline", "main", "high"], "maxLevel": 52, "bitDepths": [8] },
      "hevc": { "profiles": ["main", "main10"], "maxLevel": 153, "bitDepths": [8, 10] },
      "vp9":  { "profiles": ["profile0", "profile2"] }
    },
    "hdr": ["hdr10", "hdr10plus", "hlg", "dv:5,7,8", "dvfallback"],
    "maxHeight": 2160, "maxFps": 60, "maxBitrateKbps": 120000,
    "audio": {
      "aac": { "maxChannels": 8 },
      "ac3": { "maxChannels": 6, "decode": true, "passthrough": true },
      "eac3": { "maxChannels": 8, "decode": true, "passthrough": true, "atmos": true },
      "truehd": { "passthrough": true, "atmos": true },
      "dts": { "passthrough": true }, "dtshd": { "passthrough": true }, "dtsx": { "passthrough": true }
    },
    "maxAudioChannels": 8,
    "containers": ["mp4", "mkv", "ts", "webm"],
    "streaming": ["hls-fmp4", "hls-ts"],
    "subtitles": ["vtt", "srt", "pgs"]
  },
  "audio": 2, "quality": "original", "subtitle": { "streamIndex": 4 }
}
```

* `hdr`: `hdr10`, `hdr10plus`, `hlg`, `dv:<profiles>` (`dv:5,8`), and `dvfallback` (the player itself plays the HDR10 / HLG
  base layer of a Dolby Vision **profile 8** file whose profile it lacks; Android's Media3 is expected to, but this was not checked on a device).
  Only profile 8 is ever assumed to fall back; profile 7 files are remuxed with the RPU removed instead.
* `audio.<codec>`: `decode` (default true; the client decodes it itself), `passthrough` (it hands the bitstream to an AV receiver),
  `atmos` / `dtsx` (object audio is understood, not just the 5.1 / 7.1 bed), `maxChannels`. Listing `truehd`, `dtshd` or `dtsx`
  with no flags means passthrough only. Codec keys: `aac ac3 eac3 truehd dts dtshd dtsx flac opus mp3 vorbis pcm alac`
  (`dts` = core / ES / 96-24, `dtshd` = HRA / MA).
* `containers`: files it plays as they are (`mp4 mov mkv webm ts avi ...`). `streaming`: `hls-ts`, `hls-fmp4`.
* `subtitles`: formats it renders itself. A picture subtitle (PGS, VobSub) it does not list is burnt in by the server.
* A stated part replaces that part of the platform default; everything else comes from the default. Unknown keys are dropped,
  numbers clamped, lists capped.

A client that sends nothing gets the **conservative default profile for its platform** (from `client`, else its User-Agent):

| Platform | Video | HDR | Audio | Containers played as they are | Streaming |
|---|---|---|---|---|---|
| `androidtv` / `firetv` | H.264, HEVC Main/Main10, VP9 | HDR10, HLG; assumed to play a profile 8 Dolby Vision file's HDR10 base layer itself | AAC, AC-3, E-AC-3 (decode), FLAC, Opus, MP3 | mp4, mkv, ts, webm | hls-ts, hls-fmp4 |
| `appletv` | H.264, HEVC Main/Main10 | HDR10, HLG, **Dolby Vision 5 and 8** | AAC, AC-3 / E-AC-3 incl. Atmos (decode + pass on) | mp4, mov (**no MKV**) | hls-fmp4, hls-ts |
| `ios` | as Apple TV | as Apple TV | AAC, AC-3, E-AC-3 (Atmos) | mp4, mov | hls-fmp4, hls-ts |
| `roku` | H.264, HEVC, VP9 | HDR10 | AAC, AC-3 / E-AC-3, FLAC, Opus | mp4, mkv, mov, ts | hls-ts, hls-fmp4 |
| `samsung` (Tizen) | H.264, HEVC, VP9, AV1 | HDR10, **HDR10+**, HLG, **no Dolby Vision** | AAC, AC-3, E-AC-3, FLAC, Opus | mp4, mkv, ts, webm | hls-ts, hls-fmp4 |
| `lg` (webOS) | H.264, HEVC, VP9, AV1 | HDR10, HLG, **Dolby Vision 5 and 8**, no HDR10+ | AAC, AC-3, E-AC-3, FLAC, Opus | mp4, mkv, ts, webm | hls-ts, hls-fmp4 |
| `xbox` | H.264, HEVC, VP9, AV1 | HDR10 | AAC, AC-3, E-AC-3, FLAC, Opus | mp4, webm | hls-fmp4, hls-ts |
| `chromecast` | H.264, HEVC, VP9 | HDR10 | AAC, AC-3 / E-AC-3 (pass-through), Opus, FLAC | mp4, webm | hls-fmp4, hls-ts |
| `android` (phone) | H.264, HEVC, VP9 | HDR10 | AAC, AC-3, E-AC-3, Opus, FLAC | mp4, mkv, ts, webm | hls-ts, hls-fmp4 |
| `chrome` / `edge` / `firefox` | H.264, VP9, AV1 | none (a browser cannot know the screen) | AAC, MP3, Opus, Vorbis, FLAC | mp4, webm | hls-ts, hls-fmp4 |
| `safari` | H.264, HEVC | none | AAC, AC-3, E-AC-3, ALAC, FLAC | mp4, mov | hls-fmp4, hls-ts |
| `generic` (unknown) | H.264 High L4.1, 1080p, 30 fps, 20 Mbps | none | AAC, MP3 stereo | mp4 | hls-ts |

The defaults **never assume** TrueHD / DTS / DTS-HD / DTS:X passthrough, Dolby Vision (except where the platform is known to have
it: Apple, LG), or HDR10+ (except Samsung). A real client should send its own profile. The intended sources: Android
`MediaCodecList` + `AudioCapabilities` (`getEncodings()` for HDMI passthrough) + `Display.getHdrCapabilities()`; tvOS
`AVPlayer.availableHDRModes`; browsers `MediaCapabilities.decodingInfo()`; Roku `roDeviceInfo`; Tizen `webapis.avinfo`. **The desktop work did not change
those clients; the client work of 2026-09-21 did** (section 10): each now sends its own declaration and follows the plan, and every client still works with an older server (it uses `/playback/start` when
`GET /api/playback/info` has no `homeTheater` block).

## 3. How the server decides

`POST /api/playback/negotiate` returns the plan and the URL that plays it. `GET /api/playback/info` carries the same plan for
the calling device in `homeTheater.plan`.

* **DirectPlay**: the device plays the original file (`/file` / `/tvfile`, HTTP range requests, no ffmpeg). Needs: container,
  video (codec, profile, level, bit depth, size, frame rate, bitrate), HDR form and the chosen audio track all fine.
* **DirectStream**: a remux. Picture and (where the device plays it) sound are copied into fragmented-MP4 HLS
  (`/hls/<ticket>/master.m3u8`). Used when only the container, the Dolby Vision profile or one audio stream is the problem.
* **Transcode**: the live conversion (H.264 8-bit SDR; HDR is tone-mapped). Sound is still decided separately (copied when the
  device plays it, else E-AC-3 / AC-3 / AAC 5.1 or stereo through `hlsAudio.js`).

Each plan lists `reasons`: `{ stream, code, text, severity }`. Examples of the decision table (every row is a test in
`test/playback-decision.test.js`):

| File | Device | Plan |
|---|---|---|
| H.264 + AAC in MP4 | browser | DirectPlay |
| H.264 + AAC in MKV | browser | DirectStream (`CONTAINER_NOT_SUPPORTED`), picture and sound copied |
| 4K HDR10 HEVC + E-AC-3 in MKV | Shield | DirectPlay, HDR10 kept |
| same | Apple TV | DirectStream, `hvc1`, HDR10 kept, E-AC-3 copied |
| same | browser | Transcode (`VIDEO_CODEC_NOT_SUPPORTED`, `HDR_NOT_SUPPORTED`), tone-mapped |
| Dolby Vision 8.1 + Atmos (E-AC-3) | Apple TV | DirectStream, `dvh1`, Dolby Vision kept, Atmos E-AC-3 copied |
| same | Samsung (no Dolby Vision) | DirectStream, DV layer removed, plays HDR10 (`DV_PROFILE_NOT_SUPPORTED`) |
| Dolby Vision 5 | Samsung | Transcode, tone-mapped (`DV_PROFILE5_NO_FALLBACK`; profile 5 has no HDR10 layer) |
| Dolby Vision 7 + TrueHD Atmos 7.1 | Shield with passthrough | DirectPlay, TrueHD passed to the receiver |
| same | Apple TV | DirectStream: DV 7 -> HDR10 base, TrueHD -> E-AC-3 5.1 (`AUDIO_CODEC_NOT_SUPPORTED`, `AUDIO_OBJECTS_NOT_PRESERVED`) |
| DTS-HD MA 7.1 | Shield, "allow passthrough" off | DirectStream, audio converted to E-AC-3 5.1, picture still copied |
| 4K film | "always convert" or a bitrate limit | Transcode (`FORCED_TRANSCODE` / `BITRATE_EXCEEDS_LIMIT`) |
| picture subtitles (PGS) | device without PGS | Transcode, subtitles burnt in (`SUBTITLE_BURN_IN`) |

Rules worth knowing:

* Only AAC, AC-3 and E-AC-3 (incl. Atmos JOC) can be **copied inside HLS** (`AUDIO_CODEC_NOT_CARRIED_BY_HLS` otherwise). TrueHD,
  DTS, DTS-HD and DTS:X reach a receiver only through **DirectPlay of the original file** (a device that lists them and opens
  the container), never through a stream. ffmpeg *can* write TrueHD / DTS into MP4 (section 5) but no HLS player plays them.
* Object audio (Atmos, DTS:X) survives only a copy. Any conversion says `AUDIO_OBJECTS_NOT_PRESERVED` and plays as regular
  5.1 / 7.1 (`hlsAudio.js` never claims otherwise).
* Dolby Vision profile 5 has no HDR10 fallback: a device without Dolby Vision gets a tone-mapped conversion, and correct colours
  need `libplacebo`; the `zscale` tone-map cannot decode the IPT-PQ-C2 colour space (the reason text says so). Profile 7 / 8 with
  an HDR10 (or HLG) base can be played as HDR10 with the RPU stripped. **Profile 7's enhancement layer is never played**: ffmpeg
  drops it, so a "dual layer" film plays as its base layer (HDR10) or, on a device that plays profile 7 itself, directly from the file.
* Today's live conversion always writes 8-bit SDR H.264, so if a device *could* have shown HDR but a conversion is needed for another
  reason (bitrate limit, picture subtitles), the plan says `HDR_LOST_IN_TRANSCODE`. HEVC output is not built (see section 9).
* A remux that cannot start (no key frame index yet, no ffmpeg) is never a dead player: while the index is being read
  `negotiate` answers `503 { error: "preparing", retryAfterSec: 3 }` (ask again), and if it cannot be made at all the plan is
  redone as a Transcode with reason `REMUX_UNAVAILABLE`.

## 4. Settings > Playback > Home theater

Server-wide, with an optional per-person override (`homeTheater` and `homeTheaterUsers[<id>]` in the settings store):

| Setting | Meaning |
|---|---|
| Direct play preferred (default on) | off: prefer a remux even when the file would play as it is |
| Allow direct stream (default on) | off: only DirectPlay or Transcode |
| Allow passthrough (default on) | off: TrueHD / DTS-HD / Atmos are not trusted to a receiver; that sound is converted (picture still copied) |
| Highest bitrate to play as it is (default no limit) | a file above it is converted (a copy cannot lower a bitrate); also the client's own `maxBitrateKbps` and the request's |
| Always convert (testing) | never direct play, never remux |

A person's override only names what differs; a field that is missing inherits. `GET /api/playback/hometheater` shows the profile the
server assumed for the caller and the effective settings.

## 5. What the LGPL ffmpeg can copy (measured)

The app bundles a BtbN LGPL build (`N-126390-g9fc8c785e2-20260903`, `--enable-version3`, libopenh264, libaom, libdav1d, libopus,
libplacebo, libsvtav1, libzimg, libkvazaar, **no libx264 / libx265**). It has the bitstream filters `dovi_rpu`, `hevc_metadata`,
`dca_core`, `eac3_core`, `truehd_core`. Copying needs no encoder; every result below was measured on that binary (and on a GPL
full build 9.0.1, same results):

| Question | Answer |
|---|---|
| Can it copy HDR10 HEVC into fragmented MP4? | Yes, bit for bit (test compares the MD5 of the copied stream). Needs `-tag:v hvc1`; the default is `hev1`, which Apple devices and browsers refuse. |
| Dolby Vision signalling? | The MP4 muxer **silently drops** the `dvcC` / `dvvC` configuration box unless `-strict unofficial` is given; then `-tag:v dvh1` writes `dvvC` (profile 8) or `dvcC` (profile 7) and ffprobe reads the same profile back. |
| Strip Dolby Vision for an HDR10-only player? | Yes: `-bsf:v dovi_rpu=strip=1`, no box left, `hvc1`, still HDR10. |
| E-AC-3 (incl. Atmos JOC) into fMP4? | Yes, tag `ec-3`, **only with `-movflags +delay_moov`** (without it: "Cannot write moov atom before EAC3 packets parsed"). ffmpeg's muxer carries the JOC flag in the `dec3` box (from its source; **not verified with a real Atmos file**). |
| TrueHD into MP4? | Only with `-strict -2` (experimental), tag `mlpa`. No HLS player plays it, so it is never offered. |
| DTS into MP4? | Written as `mp4a` with a non-standard object type. Never offered in HLS. |
| Dolby Digital Plus / TrueHD / DTS **encoders**? | `eac3`, `ac3` are normal encoders (used for conversions). `truehd` and `dca` are experimental (`-strict -2`) and only used by the tests to make sample sound. Neither can make Atmos or DTS:X. |
| HEVC encoder for tests? | The bundled build has Kvazaar (8-bit); the GPL build has x265 (10-bit). Tests use whichever exists; copying HEVC needs none. |
| What is missing? | Nothing needed for the copy path. Not possible with ffmpeg alone: **creating** Dolby Vision (needs Dolby's RPU generator), HDR10+ or Atmos / DTS:X streams, **converting** Dolby Vision profile 7 to 8.1 (needs `dovi_tool`; today profile 7 is played as its HDR10 base), and correct Dolby Vision profile 5 tone-mapping without `libplacebo`. |

## 6. Direct stream in detail (`hlsRemux.js`)

* A **key frame index** (one ffprobe pass over the video packets, I/O only, cached on disk) gives the cut points. Pieces are about
  6 s, start and end on key frames, and carry their real durations in `#EXTINF`.
* ffmpeg writes fragmented MP4 to a pipe; Node cuts the fragments into the planned pieces (`seg-<n>.m4s`), so the pieces fall exactly
  where the playlist says. A seek starts a new ffmpeg run at the wanted piece.
* ffmpeg's muxer writes a **run-specific edit-list offset** for a run that starts mid-film with B-frames (measured 125 ms on an
  open-GOP HEVC film). Left alone, the picture after a seek would sit that far from the sound and from the earlier pieces. Each
  run's own `moov` is read and the difference removed from its `tfdt` boxes. A test with real HEVC and real seeks checks the joined
  result (key frames on the planned times within 2 ms, the sound restarting within one audio frame of the picture, contiguous both
  sides of the seek).
* `master.m3u8` carries `CODECS`, `VIDEO-RANGE` (PQ / HLG / SDR) and, for a kept Dolby Vision 8.x picture, `SUPPLEMENTAL-CODECS`
  (`dvh1.08.06/db1p`). **Not verified on any Apple device** (see the checklist).
* Sessions are per ticket (signed), pruned behind the viewer, stopped when far ahead, closed when idle, at most 4 at once.

Known limits: the first key frame read of a very large file is I/O-bound (measured on a 60 s test clip only: under half a second;
**not measured on a 50 GB remux**), so `negotiate` may answer "preparing" once per film. After a seek in an **open-GOP** film the first
piece can lose the 1-3 leading pictures that reference the previous group (the same thing a decoder does when it seeks to that key
frame). The remux is not shown in the server dashboard's "Now playing" transcode line yet.

## 7. What was verified, and how

Run from `desktop/apps/desktop` (use `NODE_PATH` per the repo rules). Set `BEEBO_FFMPEG` / `BEEBO_FFPROBE` to the bundled LGPL binaries
(`resources/ffmpeg/`) to test against the shipping build:

```
node --test test/media-classify.test.js test/device-profile.test.js test/playback-decision.test.js test/home-theater-settings.test.js
node --test test/hls-remux.test.js test/playback-negotiate.test.js test/library-info-formats.test.js
```

| Verified | By |
|---|---|
| Classification of HDR10 / HDR10+ / HLG / Dolby Vision 5, 7, 8.1, 8.2, 8.4 / Atmos (E-AC-3, TrueHD) / DTS, DTS-HD, DTS:X / layouts | hand-written ffprobe JSON fixtures (`test/helpers/ffprobeFixtures.js`) |
| ffprobe really reports the Dolby Vision record and the app parses it | real ffprobe on an MP4 whose `dvcC` box was written by `test/helpers/dolbyVisionMp4.js` |
| The decision table, settings, per-person override, reasons | pure tests: about 30 (file, device) rows plus tests of every setting, the request options and the reasons |
| Copy is bit-exact (picture and sound), pieces on key frames, playlist = pieces | real ffmpeg (H.264 + E-AC-3; HEVC + E-AC-3) |
| Seeks across runs join without a jump, incl. HEVC B-frames | real ffmpeg |
| hvc1 tag, HDR10 VUI survives, dvh1 + `-strict unofficial`, RPU strip, E-AC-3 needs delay_moov, TrueHD needs `-strict -2` | real ffmpeg |
| Negotiate over HTTP: DirectPlay URL serves the file, DirectStream serves master / index / init / pieces that make a bit-exact copy, forged tickets refused, settings override | a real server + real ffmpeg |
| Jellyfin `VideoRangeType`, Dv fields, `AudioSpatialFormat` | unit test on the compat module |

**Not verified (needs a real device):**

* Playback of any of it on **Apple TV / iPhone / Safari** (HLS fMP4 HEVC, `hvc1` / `dvh1`, `SUPPLEMENTAL-CODECS`, `VIDEO-RANGE`), or in Chrome / Edge via hls.js.
* That a real **TV switches to Dolby Vision / HDR10 / HDR10+ mode**, and that Dolby Vision profile 8.1 with the RPU intact plays in Dolby Vision (the test file has no RPU: it proves the signalling, not the picture).
* **Atmos / DTS:X / TrueHD reaching a receiver** as a bitstream, in DirectPlay (Media3 passthrough) or E-AC-3 JOC inside fMP4 (the `dec3` JOC flag was not checked with a real Atmos file, and no Atmos / DTS:X / HDR10+ sample was available).
* Real clients sending device profiles (none was changed), real `AudioCapabilities` / `Display.getHdrCapabilities()` values.
* Correct colours of tone-mapped Dolby Vision profile 5 with libplacebo on real GPUs.
* A remux of a real 4K 60 GB film (speed of the key frame read, disk and network limits).
* The look of the new Settings panel (built with `vite build`, not opened in the running app).

## 8. Checklist to run with a receiver / TV

You need: a UHD sample per format (HDR10, HDR10+, Dolby Vision 8.1 and 5, HLG; Dolby Digital Plus Atmos, TrueHD Atmos, DTS-HD MA, DTS:X), the app running, a device signed in.

1. Put the samples in the Movies folder. Open each in the desktop app's Movies table: the **Home theater** column should read e.g. `4K • Dolby Vision • HDR10 • Atmos • 7.1`. Wrong badge = a bug (write down the file and what ffprobe says).
2. On the device (or any machine with a token) call `GET /api/playback/hometheater` (header `X-Beebo-Client: appletv` etc.): the profile and settings the server assumes.
3. `POST /api/playback/negotiate` with `{"kind":"movie","id":"...","client":"appletv"}`. Check `plan.method`, `plan.reasons`, `plan.playsAs`.
4. Play it on the device. For each sample write down: did it play, what the TV info banner says (Dolby Vision / HDR10 / HDR10+ / HLG), what the receiver display says (Dolby Atmos / DTS:X / TrueHD / Dolby Digital+ / PCM), whether picture and sound stay in sync after seeking forward and back, whether there is a black frame or stutter at the start of a piece.
5. Repeat with Settings > Home theater: passthrough off (sound should become Dolby Digital Plus, picture unchanged), always convert (HDR should turn into a normal-looking SDR picture), bitrate limit.
6. Apple TV: check that the picture is HDR at all in a `DirectStream`. If not, capture the `master.m3u8` (`curl`) and send it: the `CODECS` / `SUPPLEMENTAL-CODECS` strings are the first suspect.
7. Shield / Fire TV: DirectPlay of the MKV; on the receiver look for the TrueHD / DTS-HD / Atmos indicator. If the receiver shows PCM, the app's HDMI passthrough setting (Sound section of the quality sheet) or the receiver's own setting is the cause.
8. Run the copy tests against the shipping ffmpeg: `set BEEBO_FFMPEG=...\resources\ffmpeg\ffmpeg.exe` then `node --test test/hls-remux.test.js`.

## 9. Not done / deferred

* **Clients sending profiles:** done in code for all six client trees on 2026-09-21 (section 10), **not verified on any real device**. Still missing: an "Always allow" style per-client override in the client UIs beyond the Samsung / LG / Xbox "Play original" switch, and reading the profile back from `GET /api/playback/hometheater` in a diagnostics screen.
* HEVC / AV1 **output** for conversions (a 4K conversion is still 8-bit SDR H.264). Needs a hardware HEVC encoder path and HEVC HLS pieces.
* Remux to **MPEG-TS** for `hls-ts`-only clients (they get a Transcode today) and **MKV** progressive remux (would let TrueHD / DTS reach passthrough-capable players that cannot open the original container).
* Dolby Vision profile 7 -> 8.1 conversion (`dovi_tool`), DTS core extraction (`dca_core`) as a lower-quality passthrough for DTS-only receivers.
* Jellyfin `DeviceProfile` -> Beebo profile mapping (the Jellyfin-compat route still uses its own direct-play check).
* Remux sessions in the dashboard "Now playing" and `/metrics`; key frame index build in the background for the whole library (like the seek-preview sweep) so the first play never waits; reading key frames from the MP4 `stss` / MKV Cues instead of the whole file.
* Detecting HDR10+ / Dolby Vision in raw transport streams without a configuration record.

## 10. Clients that send a profile (2026-09-21)

Every client feature-detects the route (the `homeTheater` block of `GET /api/playback/info`), sends the declaration in the **body** of `POST /api/playback/negotiate` and, when the TV or
box refuses what the server picked (a player error on a direct play or direct stream), goes back **once** to the plain conversion from the same position. None was run on a real device. What each declares:

| Client | Where the values come from | Never claimed | Unverified |
|---|---|---|---|
| **Samsung Tizen / LG webOS / Xbox** (`apps/smarttv`, `apps/xbox`) | `video.canPlayType` / `MediaSource.isTypeSupported`; Samsung `webapis.avinfo`, LG `webOS.deviceInfo`, Xbox `matchMedia('(dynamic-range: high)')` | HDR10+, TrueHD, DTS, DTS-HD, DTS:X; Dolby Vision except webOS-reported; `hls-fmp4` on the native engines | what each engine's `canPlayType` says, the vendor API names, direct-play of MKV / fMP4 HLS |
| **Roku** (`apps/roku`) | `roDeviceInfo.CanDecodeVideo / CanDecodeAudio`, `GetVideoMode`, `GetDisplayProperties` | Dolby Vision, HDR10+, Atmos, TrueHD, DTS-HD, DTS:X; DTS core only when `CanDecodeAudio` reports pass-through | the exact roDeviceInfo keys and answers |
| **Apple TV / iPhone / iPad** (`apps/apple`) | VideoToolbox hardware decode, `AVPlayer.availableHDRModes`, `AVAudioSession` | HDR10+, Dolby Vision profile 7, TrueHD, DTS*, Matroska | everything (not compiled here); real values on hardware |
| **Android TV / Fire TV / phone** (`apps/core`) | `MediaCodecList` (hardware decoders), `Display.HdrCapabilities`, Media3 `AudioCapabilities` (HDMI) and the "HDMI passthrough" setting | TrueHD / DTS / DTS-HD passthrough unless the output reports the encoding (and the setting is not Off); DTS:X | real values on a Shield / Fire TV; Media3's fallback for Dolby Vision profile 8 |

Movie Night (`docs/MOVIE-NIGHT.md`) is opened from the Android app (More > Movie Night, a web view restricted to the computer) and the Apple app (web view on iPhone / iPad; address + QR on Apple TV, which has no web view); the Roku only
shows the address to open elsewhere.
