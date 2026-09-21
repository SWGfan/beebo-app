# Add-ons: optional downloadable components

Beebo Desktop ships small. Anything big, niche or with its own licence is an **add-on**: a component the
owner can download from **Settings > Add-ons**, use, verify and remove again. The first add-on is the
local **Speech Pack** (automatic subtitles). This document is the contract for adding the next one, and the
base for a future community add-on / plugin story.

Code lives in `desktop/apps/desktop/electron/addons/`. Tests: `test/addons-registry.test.js`
(framework) and `test/speech-pack-*.test.js` (the Speech Pack).

## The rules every add-on lives by

1. **Nothing is bundled.** The installer carries no add-on binary and no model. Only the *manifest*
   (a few lines of data) is in the app.
2. **User-initiated, with the size shown first.** Nothing downloads until the owner presses Install.
3. **Pinned and checksummed.** Every file has an official release URL (a tag or a commit, never
   `latest`/`main`), its exact byte size and its SHA-256, all written in the manifest in code. The download
   is hashed while it arrives and thrown away on any mismatch; nothing is unpacked or run before that.
4. **Open licences only,** recorded in `THIRD_PARTY_LICENSES/` (a `<NAME>-NOTICE.md` plus the licence texts) and
   listed in `THIRD_PARTY_LICENSES/OPEN-SOURCE-LICENSES.md`.
5. **Local.** An add-on must not need a cloud call to do its job.
6. **Safe to run.** Programs are started without a shell, with a fixed argument list built from validated values,
   a minimal environment, low priority, a timeout and an output cap. Files live in a private folder.
7. **Owner only.** The IPC handlers only answer Beebo's own window; HTTP admin routes are owner-only over https.

## How it fits together

```
electron/addons/
  manifest.js    the manifest schema + validateManifest() + platform / host-allowlist helpers
  catalog.js     CATALOG = the manifests this build offers          <- register new add-ons here
  download.js    downloadVerified(): https-only, host allowlist, size ceiling, resume, SHA-256, AbortSignal
  archive.js     extractArchive(): zip / tar.gz without external tools, flat, allow-listed names, capped
  index.js       createAddonManager(): list / install / uninstall / verify / resolve / cancel / dataDir + progress events
  speechPack/    the first add-on (manifest, whisper runner, srt, job queue, wiring)
electron/addonsIpc.js         Settings > Add-ons IPC (window only), progress pushed to the window
src/components/AddonsSettings.jsx   the Settings section
```

On disk, under `userData/addons/`:

```
.downloads/<sha16>-<name>.part   partial downloads, kept so a cancelled install can resume
.tmp/                            per-install staging (swept at start-up)
<id>/state.json                  what is installed: version, archive sha256, and the sha256 of every file we wrote
<id>/<component>/...             installed files
<id>/data/...                    the add-on's own data (jobs, caches); survives uninstall unless purged
```

### The manifest

```js
{
  schema: 1,
  id: 'speech-pack',                    // lowercase, digits, '-'
  name: 'Speech Pack', summary: '...', description: '...', version: '1',
  homepage: 'https://...', publisher: 'Beebo Entertainment',
  licence: 'MIT (...)', licenceFiles: ['SPEECH-PACK-NOTICE.md', 'WHISPER-CPP-MIT.txt'],
  allowedHosts: ['github.com', '*.githubusercontent.com'],   // EVERY hop of a download must be one of these
  components: [{
    id: 'engine',                       // unique per (id, platform)
    name: 'whisper.cpp speech engine (Windows, 64-bit)', version: 'v1.9.2', licence: 'MIT',
    kind: 'archive',                    // or 'file'
    group: 'engine',                    // UI grouping
    required: true,                     // installed whenever the add-on is; optional ones are ticked by the owner
    platform: 'win32-x64',              // 'any' | 'linux-x64' | ['win32-x64', ...]
    url: 'https://github.com/.../whisper-bin-x64.zip', size: 8194445, sha256: '49dcc1...',
    format: 'zip', extract: ['whisper-cli.exe', '*.dll'], executable: 'whisper-cli.exe', unpackedMaxBytes: 83886080
    // kind 'file' instead has:  fileName: 'ggml-base.en.bin'
    // info: {...}                      // free-form, shown by the UI
  }, ...]
}
```

`validateManifest()` refuses: a non-https URL, a host outside `allowedHosts`, a floating URL, credentials in a URL,
a bad checksum or size, unsafe file names, an archive without an executable or a size cap. An invalid manifest is
ignored (and reported in `manager.problems`), never half-loaded. The built-in catalog is checked by a test.

Several components may share an `id` if their `platform` differs (the Speech Pack has one `engine` per OS);
`componentsFor(manifest, platform)` picks the right one.

### The manager API

```js
const { getSharedManager } = require('./addons')   // one per process (main.js and the stream server share it)
manager.list()                        // [{ id, name, supported, installed, busy, progress, components: [{ id, size, installed, ... }] }]
await manager.install(id, { components: ['model-base.en'] })   // required + chosen; resolves { ok, installed, skipped } | { ok:false, error, message }
manager.cancel(id)                    // keeps the partial download
await manager.uninstall(id, { components, purge })
await manager.verify(id)              // re-hash every installed file against state.json
await manager.resolve(id, 'engine')   // { file, files, dir } -- THE gate before running anything (see below)
manager.dataDir(id)                   // private data folder
manager.on('progress', ev => ...)     // { id, componentId, phase: downloading|extracting|installing|done|error|cancelled, received, total, percent, message }
manager.onBeforeUninstall(async (id, componentIds) => ...)     // stop what is using the files
manager.on('uninstalled', ({ id, components }) => ...)
```

Errors carry a `code`: `unknown_addon`, `unsupported_platform`, `bad_component`, `busy`, `not_enough_space`,
`host_not_allowed`, `insecure_url`, `too_many_redirects`, `http_error`, `network`, `timeout`, `size_mismatch`,
`checksum_mismatch`, `extract_failed`, `install_failed`, `cancelled`, `not_installed`, `corrupt`.

**Always call `resolve()` before running an add-on program or opening its model.** It re-checks the file against the
hash recorded at install time (large files are only re-hashed when their size or modified time changes), so a program
that was swapped on disk is never executed. It throws `not_installed` or `corrupt`.

Disk space is checked before the first byte is fetched: (download + unpacked size) x 1.05 + 64 MB.

## Adding a new add-on: checklist

1. **Pick the component(s)** and check every licence. Only open licences. Record them:
   `THIRD_PARTY_LICENSES/<NAME>-NOTICE.md`, the licence texts, and a paragraph in `OPEN-SOURCE-LICENSES.md`.
2. **Write the manifest** in `electron/addons/<name>/manifest.js`. Get the SHA-256 and size from the publisher's own
   release page (GitHub shows an asset `digest`; Hugging Face shows the LFS `oid`), pin a tag or commit, and note the
   date you read them in a comment. Add it to `CATALOG` in `catalog.js`.
3. **Write the feature module** (`electron/addons/<name>/`). It receives the manager and calls
   `await manager.resolve(id, componentId)` for every use. Run programs through `speechPack/whisper.js`'s
   `runChild()` pattern (no shell, validated arguments, minimal environment, low priority, timeout, abort signal), or
   reuse `runChild` directly.
4. **Be polite.** Background work must wait while anyone is watching, converting, on battery or with a busy CPU. Pass
   the stream server's `houseIsBusy` in (see how `streamServer.js` wires `speechPack`) and check it between units of
   work; make units small and the job resumable (persist progress).
5. **Expose it** through a small IPC surface (see `addonsIpc.js` `speech:call`) - only allow-listed call names - and, if
   it needs HTTP, owner-only `/api/admin/...` routes (`serverDashboard.canStopStreams(apiUser)` is the owner check).
6. **UI:** the generic card in `AddonsSettings.jsx` renders any manifest (required parts, optional choices with sizes,
   install / cancel / verify / uninstall). Add a panel for add-on specific settings the way `SpeechPackPanel` does.
7. **Tests** with fakes, no network: use `test/helpers/addonFixtures.js` (local file server, zip/tar builders, a fake
   catalog) - cover checksum failure, install / uninstall, and whatever your feature does with the fake program.
8. **Update the notice** and this file if you add a new kind of component (a new archive format, say).

## The Speech Pack

* **Engine:** whisper.cpp v1.9.2 `whisper-cli` - official release asset `whisper-bin-x64.zip` (Windows x64) and
  `whisper-bin-ubuntu-x64.tar.gz` (Linux x64). Only `whisper-cli(.exe)` and its libraries are unpacked.
  There is no official macOS or Windows-ARM CLI build among the assets we pin, so those platforms show "not available".
* **Models** (ggml, from `huggingface.co/ggerganov/whisper.cpp` at a pinned commit): tiny / base / small, each English-only
  (`.en`, better for English) or multilingual - 6 choices, 74 to 465 MB. The owner ticks which to download.
* **Licences:** whisper.cpp MIT; OpenAI Whisper weights MIT; `SDL2.dll` in the Windows archive zlib.
  See `THIRD_PARTY_LICENSES/SPEECH-PACK-NOTICE.md`.

### What it does

* **Generate subtitles** for a movie/episode: ffmpeg cuts 16 kHz mono chunks (5 minutes + 2 s overlap) into a private work
  folder, whisper transcribes each chunk, the segments are cleaned (blank-audio tags, repeated-line loops, overlaps),
  wrapped to two lines of 42 characters and written **atomically** as `Name.<lang>.ai.srt` next to the video.
* **Language:** an English model writes English. A multilingual model samples the audio (two 30-second clips) to
  detect the language, or takes the language the owner chose; **translate to English** writes `Name.en.ai.srt`.
* **Label:** the `.ai` marker makes every subtitle list show **"English (AI-generated)"** - the desktop details page
  (`mediaInfo.js`), the phone/TV/web player and the Android app (`/api/subtitles`, `/api/playback/info`), and the
  Jellyfin-compatible API. The naming/label rule lives in `electron/aiSubtitles.js`.
* **Polite background job** (`speechPack/jobs.js`, one job at a time, low priority, about half the CPU threads):
  before every chunk it waits while anyone is watching, a live conversion or the converter queue is running, on battery
  or with a busy CPU (the stream server's `houseIsBusy`, i.e. `backgroundGate.js`). If that starts *during* a chunk the
  chunk is stopped and redone later (at most about 5 minutes of work lost).
* **Resumable:** after each chunk the segments so far are saved under the add-on's data folder; a restart continues at the
  next chunk. If the video file changes (size/mtime) the job starts over.
* **Queue view** (Settings > Add-ons > Subtitle generation): progress, why it is paused, cancel, try again, remove, cancel all.
  The same queue is available to the owner over `/api/admin/ai-subtitles` (GET status, POST `/enqueue`, POST `/cancel`).
* **Per-library switch:** "Automatically make subtitles when a title has none" - **default OFF**, per library folder. A scan
  every 30 minutes queues titles with neither a subtitle file nor a built-in subtitle stream (at most 25 per scan, failures
  are not retried for a week).
* **Never overwrites** an existing `.ai.srt` unless the owner explicitly asks. Job records and logs carry ids and counts,
  never titles, paths or transcript text.

### Settings keys (electron-store)

`aiSubtitleJobs`, `aiSubtitleAttempts`, `aiSubtitleChecked`, `aiSubtitleLibraries` (per-library switches),
`aiSubtitlesModel`, `aiSubtitlesLanguage`, `aiSubtitlesTranslate`, `aiSubtitlesPauseOnBattery`, `aiSubtitlesThreads`.

## Toward community add-ons

Today the catalog is compiled in, which is what makes the checksum trustworthy: a URL or hash can only change through a
code review of a Beebo release. A community/plugin story can build on the same pieces without loosening that:

* **Signed catalog:** ship the catalog as a JSON file signed with a Beebo key (verified like `updateTrust.js` verifies updates),
  so new add-ons can appear between app releases while every download is still pinned to a hash.
* **Owner-approved third-party sources:** a "Add from a link" flow that shows publisher, licence, requested permissions and
  hashes and needs an explicit confirmation before *anything* is fetched; such add-ons would be marked "not verified by
  Beebo".
* **Capabilities:** an add-on declares what it may do (run a program, add a background job, add a Settings panel,
  add an owner-only route); the manager only wires those. Nothing here lets an add-on run inside the main process today -
  programs are always separate processes started by `runChild`.

None of that is built yet; the manifest schema has `schema: 1` so it can grow.
