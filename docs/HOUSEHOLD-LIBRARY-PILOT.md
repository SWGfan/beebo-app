# Household library pilot: desktop foundation

Status: implemented locally, capability off by default. This stage manages metadata only. It does not stream from another computer, publish metadata, register a remote connector, open router ports, or change existing playback and licensing paths.

## Capability and ownership

The exact capability is `householdLibraryPilot === true`. The module does not enable it, and existing subscriptions do not enable it automatically. Construction and disabled status checks do not initialize a host identity, scan files or create source folders. Every exposed IPC route is restricted to the current desktop main window and its main frame.

`electron/householdCatalog.js` owns a persistent UUID in `householdLibraryHostId` and source/snapshot records in `householdLibraryCatalog`. The pilot supports this computer plus one other authenticated household computer, up to 32 folder sources on each, and up to 20,000 items per computer. Host identity, source permissions/catalogue and the pilot flag are excluded from settings exports and restores, including old and safety formats. Moving a backup to another computer therefore does not clone a host or enable sharing.

## Renderer API

The preload namespace is `window.beeboentertainment.householdLibrary`:

- `info()` returns enabled status, local host identity/label, maximum host count and `playbackSupported:false`.
- `configureLocalHost({name,connectionType,externalPort})` edits the computer label and connection setup preference. `connectionType` is `relay` or `direct`; an optional external port must be 1–65535.
- `pickSource()` opens a folder picker and returns the selected path to this local desktop only.
- `addSource({folder,name,kind,consent:true})` explicitly registers a Movies (`movies`) or TV (`tv`) folder. Registration does not scan it.
- `removeSource(sourceId)` removes the saved source metadata only. It never removes media files.
- `scanSource(sourceId)`, `scanStatus()` and `cancelScan()` manage an explicit asynchronous read-only scan. Cancellation, missing drives, scan limits and failures retain the previous complete catalogue.
- `catalog({offset,limit})` returns computer/source summaries and up to 500 items per page. Results contain labels and opaque IDs, without filesystem paths.

Private-vault folders and application data are always excluded. Source registration rejects symlinks/junctions and overlapping folders. Scanning skips protected/system directories and linked files. Protection is checked again before saving or presenting local entries. A scan reads filenames, size and modification time; it does not read media contents, fetch artwork, move files, upload files or record viewing history.

## Shared metadata contract

A displayed item has `id`, `kind` (`movie` or `episode`), `title`, optional `year`, `bytes`, `modifiedAt`, and `sources:[{sourceId,hostId,hostLabel,availability,lastSeen}]`. A source has `sourceId`, `hostId`, `label`, `kind` (`movies` or `tv`), `online`, availability text, and last scan/seen times. Timestamps are Unix milliseconds. Availability can be `available`, `offline`, `missing` or `unknown`; unknown must never be presented as online.

Each discovered file is currently one item with one source. Duplicate-title/edition merging requires an explicit metadata identity decision in a later stage. No item is playable through this pilot yet, even when a source folder is available.

Local folders become `unknown` after an application restart until explicitly scanned again. Remote metadata remains visible when its computer is offline. A saved timestamp never proves current connectivity.

## Trusted backend integration

The main-process return value additionally exposes `exportSnapshot()`, `importSnapshot(snapshot,context)` and `recordHeartbeat({hostId,availableSourceIds},context)`. These methods are deliberately absent from preload/IPC.

A future connector adapter must supply a verified `getHouseholdId()` and `authorizeRemoteHost({hostId,householdId,context})`. Authorization must return the exact authenticated host and household IDs. Default authorization denies all remote imports and heartbeats. Never derive trust from a renderer boolean or accept a host's claimed household without checking membership. Signing into another household hides previous household metadata.

`exportSnapshot()` returns version 1 metadata with no local folder/file paths or authentication secrets. Imported snapshots are whitelisted, size bounded, validated and rejected if stale. Importing metadata does not mark the remote computer online. A separate authenticated heartbeat establishes freshness for 90 seconds; this in-memory evidence is cleared on restart. The travelling computer uses its own authenticated outbound Beebo connector and can be on another network. There is no same-LAN or same-house requirement.

The present main.js registration intentionally supplies no remote adapter. The existing remote host agent and streaming routes are unchanged.

## Connection setup presentation

Each host includes `connection:{preferredType,observedType:null,testStatus:'not_tested',externalPort,requiresUniqueExternalPort,label,guidance}`. This records a preferred setup only; it must not be rendered as a working Relay or Direct route.

Suggested host card: computer name; online/offline status; saved-title count; requested Relay/Direct setup; a separate connection-test result. Direct setup explains that each desktop needs a distinct external router port where multiple computers share that router. Guide the user through configuration and verify from outside that network before claiming Direct works. Do not show raw local paths as remote addresses. Relay setup must show the actual authenticated provider/result once the connector has proved it. Current code performs no router changes or connection tests.

## Validation and next integration steps

The new test fixtures cover disabled capability behavior, main-frame authorization, no automatic scans, stable identities, explicit folder consent, read-only scans, private folders/junctions, cancellation/error retention, offline metadata, authenticated imports/heartbeats, two-computer limits, connection guidance and backup isolation.

Remaining work: a user-facing pilot screen, backend host enrollment and household membership verification, independently authenticated travelling-host connectors, route tests, then source-scoped authorized playback. Complete those before advertising multi-computer playback as available. Preserve per-user history privacy, parental filters, away-access entitlement and existing stream limits when playback is added.

## Internal model versus service wire format

The local catalogue above is a desktop storage/presentation model, not the Worker request body. The service contract is documented separately (in the private cloud service repository). No network adapter is wired at this stage.

The eventual adapter must retain the service-issued host ID separately from the persistent local installation ID; map each local item ID to the service's per-file `sourceId`; convert local epoch milliseconds to service epoch seconds and back; flatten the selected folder groups; retain `expectedRevision` for compare-and-swap; and enforce the service's 2,000-item and 512 KiB full-snapshot limits without silently truncating a library. Local folders can cache more entries than that initial service limit. Explicitly parsed episodes include `seriesTitle`, `season` and `episode`; filenames without that metadata need review before a strict service upload.

Service snapshots and desktop-internal snapshots must not be interchanged directly. The service's owner-device-only authorization and `delegatedMembersSupported:false` restriction also remain in force. A later adapter must not make the owner catalogue accessible through ordinary family or guest sessions without per-member filtering.
