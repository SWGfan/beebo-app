# Optional media organizer

The desktop Get Started page includes **Find & organize your existing files**. It is optional and does not run a search on startup. Existing library locations are preserved.

## User flow

1. Choose one or more folders, or list this computer's fixed/removable drives. Select videos, photos, or both. Existing managed folders are skipped by default.
2. Optionally enable online poster lookup. The screen explains that titles parsed from filenames are sent to TMDB; media files are not uploaded. A configured TMDB key is required for this option.
3. Run a cancellable search and browse results in pages of 50. Choose all discovered files or an explicit selection.
4. Choose any writable destination outside private/application data. New installations default to `C:\Beebo`; existing installations retain their configured paths. Choose Copy (default) or Move. The poster filter applies to videos only; photos remain included.
5. Review every planned source/destination, space estimates and warnings. Explicit confirmation is required before the execution button is enabled. Nothing is copied or moved during discovery or review.
6. After completion, open the destination or use the existing folder pickers to connect its Movies, TV Shows and Photos folders. Library roots are never changed automatically.

## Modules and boundaries

- `electron/mediaOrganizer.js`: discovery, matching adapter, opaque plans, verification, execution and local audit records. No Electron dependency.
- `electron/mediaOrganizerIpc.js`: main-window/frame validation, protected roots, native folder dialogs, drive listing and opt-in TMDB adapter.
- `src/components/MediaOrganizer.jsx` and `.css`: accessible, responsive setup panel and explicit review/confirmation.
- `electron/main.js` registers the IPC service; `electron/preload.js` exposes its limited methods.
- `electron/storageDefaults.js` changes defaults for fresh installations only.

Factory: `createMediaOrganizer({matchVideo?, getExcludedRoots?, getProtectedRoots?, onOrganized?, maxFiles?, matchTimeoutMs?, freeSpace?, now?})`.

- `scan({roots, kinds, matchPosters, destination?, excludeRoots?})` starts background discovery and returns `{ok, scanId}`.
- `status({offset?, limit?})` returns bounded progress and file results. States: idle, scanning, ready, planning, executing, complete, cancelled or failed.
- `cancel()` requests cancellation, including cancellation of an in-progress metadata lookup.
- `plan({destination, matchedOnly?, operation?, selectedIds?})` performs read-only validation and returns an opaque plan ID, counters, space estimates and a first destination page. Plans expire after 30 minutes.
- `preview({planId, offset?, limit?})` returns additional reviewed destinations, without writing files.
- `execute({planId})` consumes the plan once and starts execution. The renderer cannot supply arbitrary source/destination pairs.
- `whenIdle()` is a test/background-completion helper.

`matchVideo(item, {signal})` returns a TMDB ID, title, optional year, and poster path. Only positive IDs with a poster qualify as matched. The production adapter accepts the existing title matcher's certain/probable verdicts and caches them briefly. A timeout or network failure leaves the original unmatched.

`onOrganized({source, target, kind, mediaType, match, operation})` runs only after a verified copy/move completes. A callback failure is reported separately and does not roll back successfully organized files. The desktop callback coalesces video-library refresh notifications.

## Preservation rules

- Discovery caps at 50,000 files and 100,000 directories. It skips system/program directories, linked folders/junctions, private storage, application data, and caller-configured exclusions. Directory ancestry is rechecked before execution.
- Video classification uses explicit episode naming for TV; other videos go to Movies. Photos use modified-date year/month folders, with this limitation disclosed before confirmation.
- Every generated destination, including the audit folder, is checked against protected roots. Current source and destination protections are checked again before execution; a newly protected plan is rejected before creating any files. Checks repeat during copying and before original removal.
- Existing destinations are never overwritten. Review chooses numbered names for collisions; a new collision appearing afterward causes that item to be skipped.
- Copies are written to an exclusive temporary file, flushed and verified with SHA-256. Publication is exclusive. Filesystems without hard links use a cancellable exclusive second copy, also verified.
- Move verifies the unchanged original and destination again before removing the original. Changed sources/destinations, permission errors, insufficient capacity and cancellation preserve originals that have not already completed their verified move.
- Execution writes a flushed JSON-lines record under the destination's `.beebo-organizer` folder. Failure to maintain the record stops remaining work.
- Interrupted copies may leave an incomplete destination file, which is disclosed. The original remains unless its verified move already completed. Review the audit record before removing any leftovers.
- There is no automatic undo, resume, source-folder deletion or duplicate deletion. Files are not encrypted by this organizer; private vault storage remains a separate feature. Like other ordinary filesystem tools, it cannot provide protection against a privileged local process deliberately racing filesystem changes.

## Validation

Run from the repository root:

```
node --test desktop/apps/desktop/test/media-organizer.test.js desktop/apps/desktop/test/media-organizer-ipc.test.js desktop/apps/desktop/test/private-vault.test.js
```

The 24 tests use only temporary generated files and mocked metadata responses. They cover copies/moves, source changes, collisions, junctions, cancellation, space estimates, non-hard-link fallback, all-page review, protected-folder exclusion, renderer/frame restrictions, metadata opt-in, and fresh/existing storage defaults. No customer media has been searched or moved by these checks.

Renderer compilation passed with the repository's existing bundle-size warning. A CUA browser preview could not be inspected because the tool reported no available browsers. A final browser/desktop layout review and real user-approved trial on disposable media remain appropriate before release.
