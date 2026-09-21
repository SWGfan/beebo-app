package com.beeboentertainment.movie.player

import android.net.Uri
import androidx.annotation.MainThread
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import com.beeboentertainment.movie.core.ExpiringCache
import com.beeboentertainment.movie.core.SubtitlePolicy
import com.beeboentertainment.movie.core.UrlUtils
import com.beeboentertainment.movie.data.ApiClient
import com.beeboentertainment.movie.data.SubtitleTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async

/**
 * One place that knows a file's sidecar subtitles and turns them into MediaItem configurations.
 *
 * PlayerActivity asks for the list to draw its button; PlaybackService asks for it to put the
 * sidecars on an episode it moved to by itself, with the screen closed. When both are alive they
 * ask about the same file at the same moment, so the lookup is shared: one request, both answers.
 *
 * The answer is kept for a few minutes, well inside the 12 hours the server's `mt` media token in
 * each URL is valid for, so stepping back to an episode just watched does not ask again. A failure
 * is never kept - the next caller simply tries again.
 */
@UnstableApi
object SidecarSubtitles {

    private const val CACHE_TTL_MS = 10 * 60_000L
    private const val CACHE_MAX = 16

    private val cache = ExpiringCache<List<SubtitleTrack>>(CACHE_TTL_MS, CACHE_MAX)
    private val inFlight = HashMap<String, Deferred<List<SubtitleTrack>>>()

    /**
     * Owns the shared request, so a caller going away (the Activity closing) never cancels it for
     * the other one still waiting. Holds nothing but the request itself. Dispatchers.Main rather
     * than .immediate so the request is always in [inFlight] before it can finish.
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private fun key(kind: String, id: String) = "$kind|$id"

    /** What is already known about this file, without asking. */
    @MainThread
    fun cached(kind: String, id: String): List<SubtitleTrack>? = cache.get(key(kind, id))

    /**
     * The file's sidecars, empty for almost every file. Throws on a transport failure; callers
     * treat that as "none on offer", because playback never depends on this.
     */
    @MainThread
    suspend fun tracks(api: ApiClient, kind: String, id: String): List<SubtitleTrack> {
        val k = key(kind, id)
        cache.get(k)?.let { return it }
        val pending = inFlight[k] ?: scope.async {
            try {
                api.subtitles(kind, id).tracks.filter { it.url.isNotBlank() }
                    .also { cache.put(k, it) }
            } finally {
                inFlight.remove(k)
            }
        }.also { inFlight[k] = it }
        return pending.await()
    }

    /**
     * The sidecars as MediaItem.SubtitleConfigurations, or an empty list when there are none.
     *
     * The URL is joined onto the configured base URL with the very same UrlUtils.join the video
     * stream and the posters go through, so it resolves on whatever route the app is using - LAN
     * at home, the public address away from it - with no address of its own baked in anywhere.
     * The `mt` media token the server put in the path is what gets the fetch past the gate:
     * ExoPlayer loads a side-loaded subtitle with its own data source and sends no bearer header.
     *
     * No selection flags are set: a DEFAULT-flagged text track gets auto-selected, and subtitles
     * must never appear unless they were asked for.
     */
    fun configurations(baseUrl: String?, tracks: List<SubtitleTrack>): List<MediaItem.SubtitleConfiguration> =
        tracks.mapIndexedNotNull { index, track ->
            val absolute = UrlUtils.join(baseUrl, track.url) ?: return@mapIndexedNotNull null
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(absolute))
                .setId(SubtitlePolicy.tag(index))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(track.lang.takeIf { it.isNotBlank() })
                .setLabel(track.label)
                .build()
        }

    /** Does this item already carry sidecars? */
    fun attachedTo(item: MediaItem?): Boolean =
        item?.localConfiguration?.subtitleConfigurations?.isNotEmpty() == true

    /** The selectable text track built from the sidecar at [index], once the player has merged it in. */
    fun textGroup(tracks: Tracks, index: Int): Tracks.Group? {
        val tag = SubtitlePolicy.tag(index)
        return tracks.groups.firstOrNull {
            it.type == C.TRACK_TYPE_TEXT &&
                it.mediaTrackGroup.length > 0 &&
                it.mediaTrackGroup.getFormat(0).id == tag
        }
    }
}
