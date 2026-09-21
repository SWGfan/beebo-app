# Sound quality: what Beebo does with audio, and what it does not

Written for the owner and for whoever maintains the player code. Everything here is what the code
does today; the "Not verified" list at the end is what could only be tested without a real receiver.

For the whole home-theatre picture (Dolby Vision / HDR10+ / Atmos / DTS:X, what each device plays, direct play vs direct stream vs transcode, and a
checklist for a receiver) see `HOME-THEATER.md`; this page is about what the live conversion does with the sound.

## Video: the computer's live conversion (HLS)

`desktop/apps/desktop/electron/hlsAudio.js` decides the sound of every conversion; `hlsTranscoder.js`
puts it into the ffmpeg command. A player can ask, in `POST /playback/start`:

| Field | Values | Meaning |
|---|---|---|
| `audioMode` | `auto` (default), `stereo`, `surround`, `passthrough` | see below |
| `downmix` | `standard` (default), `dialogue` | how 5.1/7.1 folds to two speakers |
| `night` | true/false | gentle dynamic range compression |
| `normalize` | true/false | EBU R128 loudness levelling (`loudnorm`, single pass) |
| `audioDelayMs` | -500..500 | positive = sound later, negative = sound earlier |
| `audioCaps` | `{ maxChannels, codecs: ["aac","ac3","eac3"] }` | what this player can play |

Anything invalid falls back to the default. A client that sends none of these gets stereo AAC exactly
as before, with the same ticket and the same cache key.

* **Stereo** (default): a real mix-down instead of ffmpeg's plain `-ac 2`. Gains per speaker group
  (ITU-R BS.775 / Dolby Lo-Ro shape): fronts 1.0, centre 0.707 (-3 dB), surrounds 0.707, back-centre 0.5,
  bass (LFE) 0.3. `dialogue` lifts the centre 3 dB (1.0) and lowers fronts (0.85), surrounds (0.5) and
  bass (0.2). A limiter at -1 dBFS follows, so a full-scale surround mix cannot clip (plain `-ac 2` uses the
  same coefficients with no limiter and hard-clips loud scenes; measured against ffmpeg 9.0.1, dialogue
  level is unchanged from before, -3 dB below the source centre channel).
* **Surround**: 5.0/5.1/6.x/7.x tracks become 5.1 (7.1 is folded to 5.1, not dropped). The codec follows
  what the player listed: Dolby Digital Plus (E-AC-3, 640/448/384 kbps by quality), else Dolby Digital
  (448/448/384), else AAC 5.1 (448/384/320). These are ffmpeg's own encoders, which are LGPL-safe;
  libfdk_aac is never used. Tracks with fewer than 5 channels are never "widened".
* **Direct stream (copy)**: when the player listed the codec (AAC, Dolby Digital, Dolby Digital Plus,
  up to 6 channels) and nothing has to be done to the sound (no night, levelling or delay), the audio is
  copied untouched and only the picture is converted. `-copypriorss 0` is essential: without it a
  copied track has no accurate seek and starts at the key frame before the seek point, seconds ahead of
  the picture. This is covered by a long-GOP sync test.
* `auto` chooses surround or a copy only when the player says it can (`audioCaps`); `passthrough` is
  surround plus permission to copy. DTS, TrueHD, Opus, FLAC and 7.1 are always converted (they cannot ride
  in HLS).
* Every audio choice is part of the ticket, so it is its own session and its own folder of pieces. The
  piece boundaries (`-force_key_frames`, 4 s) do not depend on audio.
* Timing: every chain starts with `aresample=48000:async=1:first_pts=0`. The limiter delays the sound
  by its 5 ms look-ahead, well under what anyone can perceive; tests fail above 10 ms. Delay is
  `adelay` (positive) or `atrim` (negative), exact to the sample.

### Cost (measured with ffmpeg 9.0.1 on the development PC, 5 minutes of 5.1 pink noise, the worst case for AAC)

| Chain | CPU per second of audio |
|---|---|
| copy | 0.4 ms |
| 5.1 -> stereo AAC 192k, standard mix-down + limiter | 33 ms (plain `-ac 2` was 30 ms) |
| 5.1 AAC 384k | 55 ms |
| 5.1 Dolby Digital Plus 640k / Dolby Digital 448k | 8 ms each |
| night mode | +0 to +7 ms |
| levelling (`loudnorm`) on stereo | +48 ms (about 5% of a core) |
| levelling (`loudnorm`) on 5.1 | +330 ms (about a third of a core) |

Levelling is therefore off by default and the sheet says what it costs. Real films are cheaper than
noise for the encoders.

### Honest labels

`audioPlan` in the start answer and `playsAs` in the info answer carry plain words ("Surround 5.1 ·
Dolby Digital", "Stereo (mixed down from 5.1) · AAC", "converted from DTS"). The words never say
Atmos, DTS:X or lossless about a conversion; object audio is only ever mentioned to say it is not kept.
The file's own codec name is used for an original ("Apple Lossless" is what that codec is called).

## Web player (`playbackWebUi.js`)

The Quality sheet has a **Sound** section: what is playing, Sound mode (Auto / Stereo / Surround),
stereo mix-down (Standard / Dialogue focus), Night mode, Volume levelling, Dialogue boost (0 to +6 dB
through a soft limiter) and Audio delay (-500..+500 ms). Choices are saved per account with the
subtitle language in `playbackPrefs` (`audioMode`, `downmix`, `night`, `normalize`, `boostDb`,
`audioDelayMs`). When the profile prefs system arrives these move under `prefs.playback` (see
`_customization-extensions-plan-2026-09-21.md`, section 1.3) with `boostDb`/`audioDelayMs` marked
device-overridable.

* Auto asks for surround only when the browser's output device reports 6 or more channels
  (`AudioContext.destination.maxChannelCount`).
* Boost and a positive delay are done in the browser with Web Audio (GainNode, WaveShaper soft limiter,
  DelayNode), so they need no conversion. The video element is only routed through Web Audio once the
  viewer asks for one of them, and never in browsers that play HLS natively (Safari, Android Chrome),
  which go silent when a stream is routed through Web Audio. There the delay is made by the computer.
  The "screen off" hand-over plays the same file in a separate audio element and therefore bypasses
  boost and delay.

## Android and TV (`apps/core`)

* Media3 1.4.1 already sends Dolby Digital, Dolby Digital Plus, DTS and TrueHD to an HDMI receiver as a
  bitstream when the device reports it (`DefaultAudioSink` built from a `Context` follows the HDMI
  capabilities). Beebo adds **HDMI passthrough: Auto / Off** (a device setting; Off makes the sink refuse
  compressed formats so they are decoded on the device), a probe of what the output really accepts, and
  a line in the sheet saying what reached the output ("Sent to your TV or receiver as Dolby Digital Plus
  (5.1), undecoded" or "Decoded on this device, 5.1 output"), read from the real `AudioTrack`
  configuration rather than assumed.
* The start request carries `audioMode` and `audioCaps` from that probe. A connected Bluetooth or wired
  headset means stereo whatever HDMI reports. A stereo-PCM TV that passes Dolby Digital is treated as
  surround-capable, because the bitstream carries the 5.1.
* The Sound section of the existing Quality & audio sheet: sound mode, stereo mix-down, night mode,
  volume levelling, HDMI passthrough, and audio delay in five steps (made by the computer, so it needs a
  conversion). Sound choices are saved per account on the computer with the other playback prefs;
  passthrough is stored on the device. `SessionStore.audio_delay_ms` is the Campsite party lip-sync
  offset and is deliberately not reused for films.
* Night mode is made by the computer. A local `DynamicsProcessing` / `LoudnessEnhancer` effect was
  left out: it is ignored on passthrough and behaves differently across OEMs.
* **No FFmpeg audio decoder is bundled.** Media3's FFmpeg extension is LGPL but must be built from
  source with native code (several MB per ABI, and a source-offer obligation). DTS and TrueHD that a
  device can neither decode nor pass through are converted by the computer instead. To add it later:
  build media3's `decoder_ffmpeg` module, add it as a dependency and call
  `setExtensionRendererMode(EXTENSION_RENDERER_MODE_ON)` in `BeeboRenderersFactory`.

## Music

* ReplayGain is read from the files' tags (`REPLAYGAIN_*`, and Opus `R128_*`) by both tag readers,
  stored per song (`gainDb`, `albumGainDb`, `gainPeak`, `albumGainPeak`) and returned by every track
  answer. The audio is never re-encoded or rewritten: lossless files stay exactly as they are.
* `INDEX_VERSION` is 2. A version 1 index is still read (ids and "recently added" dates are kept) and
  every song in it is tagged again once on the next scan.
* Website player: a spare `<audio>` preloads the next song 12 s before the end and the two trade places
  on `ended` (no new request, no new decoder start; a few milliseconds of hand-over remain, so it is
  gapless up to the browser, not sample-exact). Levelling is a GainNode per element into one master gain;
  album order uses the album gain, shuffle the song's own; the tag's peak holds boosts back. The graph is
  built only for songs that have a tag (or for the sing-along recorder), and each element is wrapped
  exactly once. The recorder taps the master gain, so a recording contains the levelled backing track.
* Android: the same rules (`MusicGain.kt`) set the player volume when a song becomes current, so a
  gapless join never plays the next song at the previous level. Android's player volume cannot exceed 1,
  so loud songs come down and quiet songs are left alone (the sheet says "not boosted on this phone").
  Switch: Music quality dialog -> Volume levelling.
* Not done (phase 2): measuring loudness for songs with no tag.

## Not verified (no real receiver or TV was available)

* Actual HDMI passthrough on a receiver, and the `AudioCapabilities` reported by real TVs.
* Real Safari / Android Chrome / Edge playback of E-AC-3 and multichannel AAC through hls.js or native HLS.
* The look of the new sheet section on a TV remote.
* A real browser's Web Audio behaviour (the tests run the page script against a fake browser and count
  the calls; the wiring, not the sound, is what they prove).
