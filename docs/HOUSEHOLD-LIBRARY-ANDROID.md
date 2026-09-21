# Android household-library foundation

This is an additive client foundation for the opt-in `householdLibraryPilot` capability. It does not enable the pilot, add network requests, change polling, switch servers, or alter the existing catalog cache or player.

## New files

- `apps/core/app/src/main/java/com/beeboentertainment/movie/data/HouseholdLibraryModels.kt`: serializable capability, household/host info, source descriptor, catalog item and per-item source models.
- `apps/core/app/src/main/java/com/beeboentertainment/movie/core/HouseholdLibraryPresentation.kt`: pure presentation state and identity helpers.
- `apps/core/app/src/main/java/com/beeboentertainment/movie/ui/HouseholdSourceLabel.kt`: passive Compose label with source name, readable status text and an icon. Status does not depend on color alone.
- `apps/core/app/src/test/java/com/beeboentertainment/movie/core/HouseholdLibraryTest.kt`: compatibility, availability and identity regression tests.

## Contract

`HouseholdLibraryCapabilities.householdLibraryPilot` defaults to false. `HouseholdLibraryInfo` has `enabled`, optional opaque `householdId`, optional `host`, and `maxHosts` defaulting to 2. Host fields are `hostId`, `label`, `status` and nullable epoch-millisecond `lastSeen`.

Source descriptors contain `sourceId`, `label`, `kind` (`movies` or `tv`), `hostId`, and nullable `online`. Catalog items contain `id`, `kind` (`movie` or `episode`), `title`, optional `year`/`poster`, and `sources`. An item source contains `sourceId`, `hostId`, `hostLabel`, `availability` and nullable epoch-millisecond `lastSeen`.

Status and kind fields remain strings so unknown future values decode without crashing. The models carry no local filesystem paths, access credentials, or playback URLs. Decoding should use the existing JSON configuration with `ignoreUnknownKeys`.

## Availability rules

Call `HouseholdLibraryPresenter.present(capabilities, info, items, freshness, sourceDetails)` after obtaining an authorized snapshot. `freshness` defaults to `UNVERIFIED`; do not change it to `CURRENT` simply because the HTTP request succeeded.

- `CURRENT` requires source availability established by current authenticated outbound connector/heartbeat evidence. Being on the same Wi-Fi, a saved hostname, `lastSeen`, or a descriptor's old `online` field cannot establish that a file is available.
- `CACHED` preserves titles and source identity, but displays availability as unverified with a saved-information explanation. It preserves `reportedAvailability` for diagnostics, without presenting it as current.
- Available, computer offline, file missing and unknown are distinct. An offline source does not remove its titles or turn them into missing titles.
- An available copy wins the display summary. Otherwise unknown evidence prevents an all-missing claim; offline plus missing remains offline. Only explicit missing evidence for every listed source yields missing.
- Conflicting repeated source evidence or duplicate source-qualified rows become unknown. Invalid source identities cannot establish available or all-missing status.
- Identity is namespaced by household, kind, item ID and host/source IDs. Do not reuse an item ID as a global cache/download/player key.
- Titles, editions and copies on different computers are not merged by title or ID alone. The current desktop contract exposes one file/source per item; cross-host deduplication needs a separate canonical identity decision.

These states describe metadata. They neither authorize playback nor make a source playable. Parental restrictions, sharing permissions and private-folder exclusions must be enforced by the backend before catalog data reaches this presentation layer.

## Exact future integration seams

1. Add a separate household repository after the worker/connector API is finalized. Gate it on the explicit capability AND household `enabled`; keep older servers on the existing route. The existing `ApiClient.kt` `movies`, `tvShows` and `episodes` functions remain unchanged.
2. `ui/screens/BrowseScreen.kt` owns the combined Movies/TV loading state and `CatalogCache` calls. Introduce a separate opt-in household presentation state there rather than placing household items in `MoviesResponse` or `TvShowsResponse`.
3. Render `HouseholdSourceLabel` alongside the new household cards/details. `ui/Common.kt` `PosterCard` is the existing card primitive; no current cards have been changed.
4. `ui/screens/TvScreen.kt` `EpisodeRow` and missing-episode rows currently use legacy episode IDs. A household episode needs a separate adapter keyed by its household/source identity; offline must not be sent through the missing-episode flow.
5. `ui/screens/MoviesScreen.kt` `playMovie` currently joins `movie.stream` to the active session's base URL and looks up downloads by `movie.id`. Do not pass household items into it. A validated source-specific playback authorization/transport is required first; the new models intentionally expose no URL shortcut.
6. Keep future household caches isolated by signed-in account/profile and household. Clear them at the existing sign-out/profile-change seams in `ui/MainActivity.kt`, and when switching libraries in `sharing/SharedLibrarySwitcher.kt`. Existing catalog/session behavior is unchanged in this implementation.
7. `SharedLibrarySwitcher` handles invitations to OTHER households and switches the active connection. It is not the household-combined-library repository and must not be repurposed to silently switch a viewer during playback.

## Validation

With the established Java 17 runtime, run from `apps/core`:

```
gradlew.bat :app:testWebDebugUnitTest --tests com.beeboentertainment.movie.core.HouseholdLibraryTest --offline --console=plain
```

The initial focused run compiled all new Android main-source files and passed all 14 tests. No APK was installed or published. The existing Gradle/compileSdk compatibility warnings are unrelated to this foundation.
