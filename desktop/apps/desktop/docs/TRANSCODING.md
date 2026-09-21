# Live transcoding ("play at a lower quality")

Beebo converts a film **while it plays** when a viewer picks 1080p / 720p / 480p (or Auto picks for them):
phones on mobile data, TVs that cannot play the original, browsers, Cast. The output is HLS (a whole-film
VOD playlist plus 4-second MPEG-TS pieces), so it travels over the home network, the away-from-home tunnel
and Beebo Relay alike. Original files are never touched.

This page is about *how the conversion is made robust*: which encoder is used, what happens when one
fails, how many run at once, HDR, and how it behaves on an old PC.

| File | Job |
| --- | --- |
| `electron/hlsTranscoder.js` | ffmpeg command builder, tickets, the **session manager** (fallback ladder, waiting line, load) |
| `electron/encoderCapabilities.js` | the **capability probe** and its cache, the owner's override, runtime health, the old-PC profile |
| `electron/hlsVideoChain.js` | the picture filters (scale, HDR tone-map methods) - shared by the real command and the probe |
| `electron/playbackApi.js` | HTTP routes; wires the service + manager together; the "server busy" answer |
| `electron/playbackSettingsIpc.js`, `src/components/PlaybackSettings.jsx` | Settings > Playback > Hardware acceleration |
| `electron/serverDashboard.js`, `src/components/Dashboard.jsx` | "Transcode load" tile |
| `electron/liveTv/liveHls.js` | Live TV uses the same encoder chain and fallback |

## 1. Encoder capability probe

ffmpeg lists `h264_nvenc` even on a PC with no NVIDIA card, so **a listing proves nothing**. At start-up
(8 s after launch, in the background, and lazily on the first conversion) Beebo test-encodes **one second**
(25 frames of a 640x360 picture) with every candidate, one after another, each in its own short child
process with a timeout:

| Encoder | Platforms | Notes |
| --- | --- | --- |
| `h264_nvenc` | Windows, Linux | NVIDIA |
| `hevc_nvenc` | Windows, Linux | detected and shown; not used for HLS pieces yet |
| `h264_qsv` | Windows, Linux | Intel Quick Sync (NV12 frames) |
| `h264_amf` | Windows, Linux | AMD |
| `h264_videotoolbox` | macOS | Apple |
| `h264_vaapi` | Linux | every `/dev/dri/renderD*` is tried in order; the first that really encodes is remembered (`device`) |
| `libx264` | any | **only if the owner's own ffmpeg has it** - never required |
| `libopenh264` | any | the LGPL software encoder the bundled ffmpeg ships with: the guaranteed floor |

Each entry is recorded `ok` / `unavailable` / `skipped` (not applicable on this OS) with a plain-words reason
("No NVIDIA graphics card or driver found.", "The NVIDIA driver is too old...", "This account is not allowed
to use the graphics device (add it to the render group).", "Did not answer within 20 s (driver stuck?)").
Unknown failures show a short excerpt that has been through `logRedact` (no paths, file names or tokens).
A probe cannot crash the app: a child that fails, hangs or cannot even start is just a "no".

**Cache.** The result is kept in memory and in the settings store (`transcodeProbeCache`). It is re-probed when
the ffmpeg binary changes (path + size + modified time), after 3 days, when the platform differs, or when the
owner presses **Check again**. It also records ffmpeg's version and whether the build is LGPL / GPL / nonfree
(a GPL build is logged once as a note; the bundled build must stay LGPL - see
`THIRD_PARTY_LICENSES/FFMPEG-SETUP.md`).

**Runtime health.** When an encoder dies during a conversion the manager reports it
(`noteFailure`); after **two** failures a *hardware* encoder is *demoted* for 10 minutes: new conversions
try it last. A first piece delivered by an encoder (`noteSuccess`) forgives its earlier failures. Blameless
failures (an unreadable file, a picture-filter problem) are never counted against the encoder.

## 2. Automatic fallback - never a dead player

Each session carries a **ladder** of steps built when it opens: for every encoder in the chain, one step per
usable HDR tone-map method, and (for HDR films) a last step with no tone-map at all.
`chain` = the working encoders in Automatic order, hardware first, software last.

A session moves to the next step - *the same session, restarting right after the last piece already made* -
when:

* the ffmpeg run exits with an error (non-zero exit), or
* a **hardware** encoder produces no piece for `hwStallMs` (10 s; doubled for a 4K source and x1.5 on a weak
  PC, where decoding the first piece alone takes longer) while a viewer is waiting (the stuck process is
  killed).

What is skipped depends on what the error text says (`classifyRunFailure`):

| Kind | Example | Next step |
| --- | --- | --- |
| `encoder` | `Cannot load nvcuda.dll`, `MFX`, `OpenEncodeSessionEx failed` | skip every step of that encoder |
| `filter` | `Error reinitializing filters`, Vulkan/OpenCL failures | next tone-map method on the same encoder; the encoder is **not** blamed |
| `input` | `Invalid data found when processing input`, no such file | **no fallback** (another encoder would fail identically); a plain error |
| `unknown` | anything else | the next step |

Exactly **one redacted log line** is written per switch:

```
transcode 6622031772a1a0746a22: Intel Quick Sync stopped (no picture from Intel Quick Sync for 10 s) - continuing with processor (OpenH264)
```

The choice sticks for the rest of the session (seeks do not go back to the failed encoder). If every step
fails the session reports an error; the next request after 30 s starts the ladder again from the best step.
Software encoders are never stall-killed - there is nothing behind them.

Piece boundaries are forced key frames and every run keeps the film's own clock (`-output_ts_offset`), so a
switch mid-film is a normal restart, exactly like a seek.

**Live TV** (`liveTv/liveHls.js`) uses the same chain: an encoder that exits early with no pieces, a hardware
encoder that crashes mid-run, or one that shows no picture for 10 s hands the session to the next encoder
(software last) instead of reporting "tuner ended". The tuner stays with the session.

## 3. Settings > Playback > Hardware acceleration

* **What was detected** - a row per encoder: *Working* / *Not available* + the reason, the device (VAAPI),
  and "failed while playing" for an encoder that was demoted.
* **Use** - the owner override, setting `transcodeEncoder`:
  * `''` **Automatic** (best available: hardware first, then processor),
  * `'software'` **Processor only** (falls back to Automatic if no software encoder works - never a dead
    player),
  * an encoder id **Prefer X** (it goes first; the rest stay behind it as fallbacks).
* **At most N at the same time** - setting `transcodeMaxConcurrent` (1-8), or *Automatic*.
* **Old or slow computer** - setting `transcodeCpuMode`: `''` Automatic, `'gentle'`, `'normal'`.
* **Check again** re-runs the test encodes (after a driver update or a new graphics card).
* A live line: "Right now: 1 of 2 running, 1 waiting."

## 4. The limit, the "server busy" message and the waiting line

`maxConcurrent` conversions run at once. The default (when the owner has not chosen) is 1 on a weak PC,
2 normally, 3 on a strong one, **plus one when a graphics encoder is in use**.

A viewer over the limit gets `POST /playback/start` -> **503**:

```json
{ "ok": false, "error": "busy", "queued": true, "position": 2, "waiting": 3, "retryAfterSec": 5,
  "message": "The server is busy right now, converting video for other people. You're number 2 in line - keep this open and it will start by itself, or choose Original quality to play straight away." }
```

The line is **first come, first served with no time estimate** (nobody can honestly promise one). Asking
again keeps the place; a viewer who has not asked for 30 s has left. When a slot frees up the first viewer in
line who asks is admitted and the slot is **held for them for 30 s** so nobody else can take it in between.
Someone switching quality/audio on what they are already watching keeps their own slot and does not queue
behind others. The web player asks again every 5 s by itself (~10 min at most); native apps show the message.
Original quality is never limited.

## 5. HDR to SDR tone-mapping

When an HDR film is converted, each method is **listed in ffmpeg and proven by running it** on a tagged HDR10
test picture (`setparams=...smpte2084`). Preference order (best first):

1. `tonemap_vaapi` (Linux, with the VAAPI encoder), 2. `libplacebo` (Vulkan), 3. `tonemap_opencl`,
4. `zscale` + `tonemap` (the processor; works everywhere the filters were built in).

The picture is scaled to the output size **before** the tone-map, so a 4K film played at 720p tone-maps a
720p picture (a big CPU saving on an old PC). Safe fallback: a failing method drops to the next one (§2), and
the last step converts with no tone-map (colours look dull, but it plays). Settings shows which method is in
use, or that HDR films may look dull at lower qualities when the ffmpeg has none. Original quality is never
affected.

## 6. Old-PC friendly defaults

`performanceProfile()` picks a tier from the core count, clock speed and memory (or from Settings):

| | low (<= 2 cores, or 4 slow cores, or < 4 GB) | normal | high (>= 8 cores) |
| --- | --- | --- | --- |
| ffmpeg priority | below normal | below normal | below normal |
| software encoder threads | cores / 2 | cores - 1 (max 6) | cores - 2 (max 8) |
| x264 preset (if the owner has x264) | `ultrafast` | `veryfast` | `veryfast` |
| OpenH264 | loop filter off, CAVLC | default | default |
| scaler | bilinear | default | default |
| default conversions at once | 1 (+1 with a GPU) | 2 (+1) | 3 (+1) |

Graphics encoders keep their own settings. All ffmpeg children are lowered to below-normal priority
(`os.setPriority`) so a long conversion cannot starve the desktop or the server.

## 7. Dashboard: "Transcode load"

`health.transcode = { active, running, max, queued, hardware, fallbacks }` (from `manager.load()`), shown as
a tile ("2 of 3", "Graphics card . 1 waiting . 1 switched encoder"), and live conversions are matched to the
viewer's row in *Now playing* ("Converting to 720p (graphics card)").

## 8. Tests

* `test/transcode-capabilities.test.js` - probe parsing/reasons, VAAPI node detection, never-throws, cache
  and re-probe rules, tone-map proof, encoder plan / override / demotion, old-PC profile, Settings IPC.
* `test/transcode-fallback.test.js` - the ladder with `test/helpers/fakeSpawn.js`: ordering, redacted log
  line, mid-film resume position, stall kill, input errors not blamed, exhausted-retry, HDR ladder, the
  waiting line, priority, load, dashboard.
* `test/livetv-hls.test.js` - live TV fallback (fake and real ffmpeg).
* `test/playback-hls.test.js`, `test/playback-api.test.js` - existing behaviour, incl. the real-ffmpeg run.

No test requires a GPU or libx264. What **cannot** be verified without hardware: NVENC / AMF / VAAPI /
VideoToolbox test encodes and their real-world failure texts, `tonemap_vaapi` / `tonemap_opencl` /
`libplacebo` on real drivers, and HEVC output.

## 9. Not done yet

* HEVC / AV1 *output* (HEVC encoders are only detected), direct-stream (remux) of compatible video,
* hardware *decoding* (`-hwaccel`) - decoding is still in software, which matters on an old PC with 4K HEVC,
* hardware acceleration for the offline "Convert" queue (`convert.js`; it uses OpenH264 by design),
* learning from measured speed (a per-encoder real-time factor) to lower the default limit automatically.
