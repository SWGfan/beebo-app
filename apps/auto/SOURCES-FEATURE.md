# Bring your own online files by link

Paste a website or video link and the app brings up your own online-hosted file
as a playable source. Saved links live in local Prefs (the source of truth) and
can optionally follow the account across devices through the hub.

Everything is **additive**. The only existing app file edited is `Prefs.kt`
(one new string, same pattern as `hubToken`). Nothing in the nav graph, the
player, or the car service was rewired — the two car-side integrations are
documented insertion points below.

## New files (`com.beeboentertainment.auto.sources`)

| File | What it is |
|------|-----------|
| `UserSource.kt` | `UserSource(id, label, url, kind, addedAt)` + `SourceKind { DIRECT_MEDIA, INDEX, UNKNOWN }`. `@Serializable`, so the same shape round-trips through both Prefs and the hub. |
| `SourceProbe.kt` | Classifies a pasted URL. Pure rules (`normalize`, `isMediaContentType`, `isMediaPath`, `parseIndex`) + a network `probe()`. Returns `ProbeResult` (`DirectMedia` / `Index` / `Unknown`) plus discovered `DiscoveredItem`s for an index. |
| `SourceStore.kt` | Persists the list in `Prefs.userSources` as JSON. Tolerant CRUD: `list`, `add` (dedupes by URL), `remove`, `get`, `replaceAll`. |
| `SourcesRepository.kt` | Public entry point. Ties probe + store together and adds optional hub sync. |
| `AddSourceScreen.kt` | Self-contained Compose section: paste field, Add button, saved-link list with Remove (and optional Open). Matches MainActivity's Material3 style. |
| `test/.../sources/SourceProbeTest.kt` | JUnit4 unit tests for URL normalization + media-type/extension classification + index parsing. |

## `SourcesRepository` — public API

```kotlin
class SourcesRepository(context: Context) {
    suspend fun addByUrl(raw: String): UserSource          // probe + save
    fun list(): List<UserSource>
    fun get(id: String): UserSource?
    fun remove(id: String)
    suspend fun resolvePlayable(source: UserSource): PlayableRef

    // optional hub sync (no-op/false when the route is absent)
    suspend fun syncToHub(token: String): Boolean
    suspend fun syncFromHub(token: String): Boolean
}

sealed interface PlayableRef {
    val source: UserSource
    data class Direct(val source: UserSource, val url: String)                 // hand url to the player
    data class Browsable(val source: UserSource, val items: List<DiscoveredItem>) // list in the browse tree
}
```

- `addByUrl` throws `IllegalArgumentException` **only** when the text can't be
  read as an http(s) link at all. A well-formed but unreachable or
  unclassifiable link is saved as `UNKNOWN` (message shown verbatim in the UI).
- `resolvePlayable` returns `Direct` for `DIRECT_MEDIA` and `UNKNOWN` (unknown is
  optimistically treated as direct), and re-probes an `INDEX` for a fresh
  listing (`Browsable`), falling back to `Direct` if it no longer looks like a
  listing.

### Classification (`SourceProbe`)

- **normalize**: trims, prepends `https://` when no scheme is present (arbitrary
  links default to https, unlike the LAN base URL which defaults to http), keeps
  the path, validates via OkHttp `HttpUrl`.
- **direct media** if `Content-Type` is `audio/*`, `video/*`,
  `application/vnd.apple.mpegurl` / `application/x-mpegurl`, **or** the path ends
  in `.mp4 .mkv .webm .m3u8 .mp3 .m4v .mov`.
- **index** if a GET body parses as a listing — a bare array or an object with an
  `items`/`entries`/`tracks`/`files`/`media` array; each item's URL is read from
  `url`/`stream`/`src`/`file`/`path`/`href` and resolved absolute. Best-effort
  and tolerant; a bare origin also gets one `/api` probe.
- else **UNKNOWN** (still saved).

Network handling reuses the app's shared OkHttp client (`Http.client(...)`,
`followSslRedirects` off) and drives the same-port http→https `308` upgrade by
hand with `ApiClient.httpsUpgradeTarget(...)`, exactly like `ApiClient` and
`HubClient`. Probe is network-tolerant: HEAD → ranged-GET sniff → bounded body
parse, and any network failure degrades to path-based classification rather than
blocking the save.

## Prefs addition

One new string in `data/Prefs.kt`, mirroring `hubToken`:

```kotlin
var userSources: String
    get() = sp.getString(KEY_USER_SOURCES, "[]") ?: "[]"
    set(v) = sp.edit().putString(KEY_USER_SOURCES, v).apply()
// companion: private const val KEY_USER_SOURCES = "userSources"
```

Owned solely by `SourceStore`; nothing else reads/writes the key.

## UI insertion point

`AddSourceScreen()` is self-contained (owns its own repository + state, adds no
nav, touches no player). Drop it into the existing settings screen. In
`ui/MainActivity.kt`, inside `Screen()`'s `Column`, e.g. just below the
"Accept any certificate" `ToggleRow`:

```kotlin
HorizontalDivider()
com.beeboentertainment.auto.sources.AddSourceScreen()
```

Optionally pass `onOpen = { source -> /* preview or hand off */ }` to show an
"Open" control per row. That is the only change needed on the phone side.

## Car playback wiring (optional — documented, not wired)

The car's browse tree (`media/Catalog.kt`) has a fixed, host-capped 4-tab root,
and playback runs in `media/PlaybackService.kt`'s `MediaSession`. To avoid
risking that code nothing here rewires it. To surface saved links in the car,
two small additions suffice:

1. **A "My Links" browse node** in `Catalog.children(...)`. Add a root/tab case
   that lists `SourcesRepository(context).list()` as `playable(...)` items for
   `DIRECT_MEDIA`/`UNKNOWN` and `browsable(...)` folders for `INDEX` (whose
   children are the `DiscoveredItem`s from `resolvePlayable`). Encode the source
   id in the `mediaId` (see `MediaIds.kt` for the string-namespace pattern).

2. **Resolution** in `PlaybackService.onAddMediaItems` / `Catalog.resolvePlayable`.
   For a user-source mediaId, one call does it:

   ```kotlin
   val ref = SourcesRepository(context).resolvePlayable(source)
   val url = (ref as? PlayableRef.Direct)?.url   // -> MediaItem.Builder().setUri(url)
   ```

   `PlayableRef.Direct.url` is exactly what `Catalog.resolvePlayable` already
   hands ExoPlayer via `api.absolute(streamPath)`, so it slots into the same
   `MediaItem.Builder().setUri(...)` path.

## Optional hub sync (so saved links follow the account)

New hub file: `beeboentertainment-hub/src/routes/sources.js` — an Express router with
`GET /` (list) and `PUT /` (replace) for the signed-in account, auth via
`auth.requireUser(db)`. It creates its own `user_sources(account_id, json,
updated_at)` table at module load with `db.raw.exec(...)` and touches no other
hub file. No `src/db.js`, `src/server.js`, or other hub file was edited.

**Mount line to add to `src/server.js`** (alongside the other `app.use('/api/v1', …)` mounts):

```js
app.use('/api/v1/sources', require('./routes/sources')(db));
```

The Android side calls it through `SourcesRepository.syncToHub(token)` /
`syncFromHub(token)` (reusing `Http.client(...)` and `HubClient.HUB_BASE_URL`).
Both are best-effort and return `false` without throwing when the route is
absent or unreachable — **local Prefs remains the source of truth and the whole
feature works with the hub route absent.**
```
