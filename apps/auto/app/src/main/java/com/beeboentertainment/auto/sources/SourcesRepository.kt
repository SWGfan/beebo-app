package com.beeboentertainment.auto.sources

import android.content.Context
import com.beeboentertainment.auto.data.Http
import com.beeboentertainment.auto.hub.HubClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID

/**
 * What [SourcesRepository.resolvePlayable] hands back.
 *
 * [Direct] carries a URL to give straight to the player; [Browsable] carries the
 * items of an index for the browse tree to list. Both keep the originating
 * [UserSource] so the caller has its label and id.
 */
sealed interface PlayableRef {
    val source: UserSource

    data class Direct(override val source: UserSource, val url: String) : PlayableRef
    data class Browsable(
        override val source: UserSource,
        val items: List<DiscoveredItem>,
    ) : PlayableRef
}

/**
 * The public entry point for the "bring your own link" feature.
 *
 * Ties [SourceProbe] (classification) to [SourceStore] (local persistence).
 * Everything the UI and the car need is here:
 *
 *   suspend fun addByUrl(raw): UserSource        — classify + save a pasted link
 *   fun list(): List<UserSource>                 — the saved links
 *   fun remove(id)                               — forget one
 *   suspend fun resolvePlayable(source): PlayableRef  — turn one into playback
 *
 * Local Prefs is the source of truth. The two hub-sync helpers at the bottom
 * are an optional bonus: they mirror the list through the coordination hub so it
 * follows the account across devices, and they no-op quietly (return false)
 * whenever the hub route is absent or unreachable. The feature works fully
 * without them.
 */
class SourcesRepository(context: Context) {

    private val app = context.applicationContext
    private val store = SourceStore(app)

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        encodeDefaults = true
    }
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    // ------------------------------------------------------------------ CRUD

    /**
     * Classify [raw] and save it. Throws [IllegalArgumentException] only when the
     * text cannot be read as a link at all; an unreachable or unclassifiable but
     * well-formed link is saved as [SourceKind.UNKNOWN].
     */
    suspend fun addByUrl(raw: String): UserSource {
        val result = SourceProbe.probe(app, raw)
        val kind = when (result) {
            is ProbeResult.DirectMedia -> SourceKind.DIRECT_MEDIA
            is ProbeResult.Index -> SourceKind.INDEX
            is ProbeResult.Unknown -> SourceKind.UNKNOWN
        }
        val source = UserSource(
            id = "usrc_" + UUID.randomUUID().toString().take(8),
            label = labelFor(result.url),
            url = result.url,
            kind = kind,
            addedAt = System.currentTimeMillis(),
        )
        store.add(source)
        return source
    }

    fun list(): List<UserSource> = store.list()

    fun get(id: String): UserSource? = store.get(id)

    fun remove(id: String) {
        store.remove(id)
    }

    // -------------------------------------------------------------- playback

    /**
     * Turn a saved source into something playable.
     *
     * DIRECT_MEDIA and UNKNOWN resolve to [PlayableRef.Direct] (UNKNOWN is
     * optimistically treated as direct). INDEX is re-probed for a fresh listing
     * — the remote list may have changed since it was saved — and falls back to
     * Direct if the re-probe no longer looks like an index.
     */
    suspend fun resolvePlayable(source: UserSource): PlayableRef = when (source.kind) {
        SourceKind.INDEX -> when (val r = SourceProbe.probe(app, source.url)) {
            is ProbeResult.Index -> PlayableRef.Browsable(source, r.items)
            else -> PlayableRef.Direct(source, r.url)
        }
        else -> PlayableRef.Direct(source, source.url)
    }

    // -------------------------------------------------------- optional hub sync

    @Serializable
    private data class Envelope(val sources: List<UserSource> = emptyList())

    /**
     * Push the local list to the hub (PUT /api/v1/sources). Best-effort: returns
     * false — never throws — when the hub route is absent or the call fails.
     * Requires a valid hub session [token] (see [HubClient]).
     */
    suspend fun syncToHub(token: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val payload = json.encodeToString(Envelope(store.list()))
                .toRequestBody(jsonMediaType)
            val req = Request.Builder()
                .url(HubClient.HUB_BASE_URL + "/api/v1/sources")
                .put(payload)
                .header("Authorization", "Bearer $token")
                .build()
            Http.client().newCall(req).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    /**
     * Pull the hub's copy and make it the local list (GET /api/v1/sources).
     * Best-effort: returns false and leaves local Prefs untouched when the route
     * is absent or the call fails.
     */
    suspend fun syncFromHub(token: String): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            val req = Request.Builder()
                .url(HubClient.HUB_BASE_URL + "/api/v1/sources")
                .get()
                .header("Authorization", "Bearer $token")
                .build()
            Http.client().newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use false
                val env = json.decodeFromString<Envelope>(resp.body?.string().orEmpty())
                store.replaceAll(env.sources)
                true
            }
        }.getOrDefault(false)
    }

    // ---------------------------------------------------------------- helpers

    /** A friendly label: the last path segment, else the host, else the URL. */
    private fun labelFor(url: String): String {
        val h = url.toHttpUrlOrNull() ?: return url
        val last = h.pathSegments.lastOrNull()?.takeIf { it.isNotBlank() }
        return last ?: h.host
    }
}
